"""A local HTTPS fixture server: static files, plus POST /submit/<name> that records exactly what
the browser sent (fields and file bytes) and answers with a receipt page.

The certificate is self-signed and made per test run in a temporary directory; browser contexts
in the tests use ignore_https_errors. Nothing here is an employer.
"""
import functools, hashlib, http.server, os, ssl, subprocess, tempfile, threading
from email.parser import BytesParser
from email.policy import HTTP
from pathlib import Path

_CERT = None


def _certificate():
    global _CERT
    if _CERT is None:
        d = Path(tempfile.mkdtemp(prefix='career-agent-tls-'))
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', str(d / 'key.pem'), '-out', str(d / 'cert.pem')],
                       check=True, capture_output=True)
        _CERT = (str(d / 'cert.pem'), str(d / 'key.pem'))
    return _CERT


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith('/redirect/'):
            self.send_response(302); self.send_header('Location', '/' + self.path.split('/redirect/', 1)[1]); self.send_header('Content-Length', '0'); self.end_headers()
            return
        if self.path.startswith('/gone/'):
            self.send_response(410); self.send_header('Content-Length', '0'); self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        message = BytesParser(policy=HTTP).parsebytes(b'Content-Type: ' + self.headers.get('Content-Type', '').encode() + b'\r\n\r\n' + body)
        fields, files = {}, {}
        if message.is_multipart():
            for part in message.iter_parts():
                name = part.get_param('name', header='content-disposition')
                if part.get_filename():
                    data = part.get_payload(decode=True) or b''
                    files[name] = {'filename': part.get_filename(), 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
                else:
                    fields[name] = (part.get_payload(decode=True) or b'').decode('utf-8')
        name = self.path.rsplit('/', 1)[-1]
        self.server.received.append({'path': self.path, 'fields': fields, 'files': files})
        reference = self.server.references.get(name, 'FIXTURE-001')
        page = (f'<!doctype html><html lang="en"><meta charset="utf-8"><title>Received (LOCAL TEST)</title>'
                f'<h1>LOCAL TEST — not an employer</h1><p id="receipt">TEST application received — {reference}</p></html>').encode()
        if self.server.slow_receipt:
            page = b'<!doctype html><html><meta charset="utf-8"><title>Processing</title><p>Processing</p></html>'
        self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(page))); self.end_headers()
        self.wfile.write(page)


def serve_https(directory):
    handler = functools.partial(Handler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    server.received = []; server.references = {}; server.slow_receipt = False
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(*_certificate())
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    server.base = f'https://127.0.0.1:{server.server_port}'
    return server
