/**
 * Ready-made lists for "Companies to search for". Company names only, from public announcements;
 * each list says when it was compiled, because contract awards change. Researched on 7 October 2026
 * from trade press and National Grid's own news (not from Find a Tender notices, which could not be read).
 */
export interface EmployerList {
  id: string;
  label: string;
  compiled: string;
  names: string[];
}

export const EMPLOYER_LISTS: EmployerList[] = [
  {
    id: 'national-grid-recent',
    label: 'National Grid and contractors it appointed, July to October 2026',
    compiled: '7 October 2026',
    names: [
      'National Grid',
      // North West London Upgrade (August 2026)
      "Laing O'Rourke", 'Murphy', 'Hochtief', 'Siemens Energy', 'Hyundai Electric',
      // Single awards (July to September 2026)
      'Spencer Group', 'Advantage NRG',
      // NGED substation civils framework (2 October 2026)
      'AmcoGiffen', 'Coombes', 'M Group', 'Pod-Trak', 'Fortis Foundations', 'Manning Construction', 'Griffiths', 'Andrew Scott',
      'Blyth Construction', 'Bridge Civil Engineering', 'Cambrensis', 'Chalfont Construction', 'Coffey', 'DAC Power', 'David Galvin Construction',
      'Enable Infrastructure', 'Envolve Infrastructure', 'Force Contracting', 'Foxfords', 'Palmer Construction', 'Knights Brown', 'Regen Construction',
      'Spencer Rail', 'Velta Construction', 'Whitehouse Construction', 'Trant Engineering', 'Tudorborne', 'A Thomas Plant Hire', 'Alpha Construction',
    ],
  },
  {
    id: 'national-grid-earlier-2026',
    label: 'Contractors National Grid appointed earlier in 2026 (March to June)',
    compiled: '7 October 2026',
    names: [
      'Balfour Beatty', 'Morgan Sindall', 'Omexom', 'Taylor Woodrow', 'OCU Group', 'Excalon', 'United Infrastructure', 'Circet', 'Doocey',
      'Network Plus', 'BAM Nuttall', 'Costain', 'Skanska', 'Kirby Group', 'Morson', 'Galliford Try', 'Hitachi Energy', 'NKT', 'Prysmian',
    ],
  },
];
