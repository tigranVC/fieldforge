// Static reference data: trades, zones, companies, price book, and name pools.
// Everything here is original, fictional data.

export const TRADES = ['hvac', 'plumbing', 'electrical'];
export const TRADE_LABELS = { hvac: 'HVAC', plumbing: 'Plumbing', electrical: 'Electrical' };

export const JOB_STATUSES = ['unscheduled', 'scheduled', 'in_progress', 'completed', 'canceled'];
export const PRIORITIES = ['low', 'normal', 'high', 'emergency'];
export const ESTIMATE_STATUSES = ['draft', 'sent', 'approved', 'declined'];
export const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'void'];
export const PAYMENT_METHODS = ['card', 'check', 'cash', 'ach'];
export const CHANNELS = ['sms', 'email'];

// Every company's service area is split into the same five zones. Coordinates
// are in miles on a flat plane; distance = Euclidean distance.
export const ZONES = {
  Central: { x: 0, y: 0 },
  North: { x: 0, y: 11 },
  South: { x: 0, y: -11 },
  East: { x: 11, y: 0 },
  West: { x: -11, y: 0 },
};
export const ZONE_NAMES = Object.keys(ZONES);

export const COMPANY_TEMPLATES = [
  { id: 'CO-1', name: 'Ironleaf Comfort Services', city: 'Maple Ridge', state: 'OR', taxRate: 0.0725, technicians: 14 },
  { id: 'CO-2', name: 'Bluepeak Home Systems', city: 'Harbor Falls', state: 'WA', taxRate: 0.06, technicians: 13 },
  { id: 'CO-3', name: 'Copperline Mechanical & Electric', city: 'Cedar Junction', state: 'CO', taxRate: 0.0825, technicians: 13 },
];

// Price book. kind -> default jobType. weight -> relative frequency in seeded jobs.
export const SERVICES = [
  { code: 'HV-DIAG', trade: 'hvac', name: 'HVAC diagnostic visit', priceCents: 8900, durationMin: 60, kind: 'service', weight: 10 },
  { code: 'HV-TUNE', trade: 'hvac', name: 'Seasonal AC/furnace tune-up', priceCents: 12900, durationMin: 60, kind: 'maintenance', weight: 12 },
  { code: 'HV-CAP', trade: 'hvac', name: 'Replace run capacitor', priceCents: 18500, durationMin: 60, kind: 'repair', weight: 6 },
  { code: 'HV-FURN', trade: 'hvac', name: 'Furnace ignition/flame sensor repair', priceCents: 29500, durationMin: 90, kind: 'repair', weight: 6 },
  { code: 'HV-BLOW', trade: 'hvac', name: 'Blower motor replacement', priceCents: 64000, durationMin: 120, kind: 'repair', weight: 3 },
  { code: 'HV-COIL', trade: 'hvac', name: 'Evaporator coil cleaning', priceCents: 22000, durationMin: 120, kind: 'maintenance', weight: 3 },
  { code: 'HV-THERM', trade: 'hvac', name: 'Smart thermostat install', priceCents: 32500, durationMin: 60, kind: 'install', weight: 3 },
  { code: 'HV-MINI', trade: 'hvac', name: 'Ductless mini-split install', priceCents: 420000, durationMin: 360, kind: 'install', weight: 1 },
  { code: 'HV-AC3T', trade: 'hvac', name: 'Central AC replacement (3 ton)', priceCents: 685000, durationMin: 480, kind: 'install', weight: 1 },

  { code: 'PL-DIAG', trade: 'plumbing', name: 'Plumbing diagnostic visit', priceCents: 7900, durationMin: 60, kind: 'service', weight: 9 },
  { code: 'PL-DRAIN', trade: 'plumbing', name: 'Main line drain clearing', priceCents: 27500, durationMin: 90, kind: 'repair', weight: 8 },
  { code: 'PL-LEAK', trade: 'plumbing', name: 'Pipe leak repair', priceCents: 24500, durationMin: 90, kind: 'repair', weight: 8 },
  { code: 'PL-FAUC', trade: 'plumbing', name: 'Faucet replacement', priceCents: 19500, durationMin: 60, kind: 'repair', weight: 5 },
  { code: 'PL-TOIL', trade: 'plumbing', name: 'Toilet rebuild', priceCents: 16500, durationMin: 60, kind: 'repair', weight: 5 },
  { code: 'PL-CAM', trade: 'plumbing', name: 'Sewer camera inspection', priceCents: 29900, durationMin: 60, kind: 'inspection', weight: 3 },
  { code: 'PL-SUMP', trade: 'plumbing', name: 'Sump pump replacement', priceCents: 78000, durationMin: 120, kind: 'install', weight: 2 },
  { code: 'PL-WH40', trade: 'plumbing', name: '40 gal water heater replacement', priceCents: 189000, durationMin: 240, kind: 'install', weight: 2 },
  { code: 'PL-TNKL', trade: 'plumbing', name: 'Tankless water heater install', priceCents: 395000, durationMin: 360, kind: 'install', weight: 1 },

  { code: 'EL-DIAG', trade: 'electrical', name: 'Electrical troubleshooting visit', priceCents: 9900, durationMin: 60, kind: 'service', weight: 9 },
  { code: 'EL-OUTL', trade: 'electrical', name: 'Outlet/switch replacement', priceCents: 14500, durationMin: 60, kind: 'repair', weight: 8 },
  { code: 'EL-GFCI', trade: 'electrical', name: 'GFCI circuit install', priceCents: 21000, durationMin: 60, kind: 'install', weight: 5 },
  { code: 'EL-FAN', trade: 'electrical', name: 'Ceiling fan install', priceCents: 26500, durationMin: 90, kind: 'install', weight: 5 },
  { code: 'EL-INSP', trade: 'electrical', name: 'Electrical safety inspection', priceCents: 17900, durationMin: 90, kind: 'inspection', weight: 4 },
  { code: 'EL-SURG', trade: 'electrical', name: 'Whole-home surge protector', priceCents: 42000, durationMin: 60, kind: 'install', weight: 3 },
  { code: 'EL-EVSE', trade: 'electrical', name: 'EV charger circuit install', priceCents: 165000, durationMin: 240, kind: 'install', weight: 2 },
  { code: 'EL-PANL', trade: 'electrical', name: '200A panel upgrade', priceCents: 345000, durationMin: 480, kind: 'install', weight: 1 },
  { code: 'EL-GEN', trade: 'electrical', name: 'Standby generator hookup', priceCents: 520000, durationMin: 480, kind: 'install', weight: 1 },
];

export const SERVICE_BY_CODE = Object.fromEntries(SERVICES.map((s) => [s.code, s]));
export const PARTS_CODE = 'PARTS';

export const FIRST_NAMES = [
  'Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Rowan', 'Harper', 'Emery', 'Skyler',
  'Dana', 'Elliot', 'Reese', 'Sage', 'Parker', 'Blair', 'Hayden', 'Kendall', 'Logan', 'Marlow',
  'Noel', 'Oakley', 'Peyton', 'Remy', 'Shawn', 'Tatum', 'Wren', 'Ari', 'Bailey', 'Cameron',
  'Devon', 'Ellis', 'Finley', 'Gray', 'Indy', 'Jules', 'Kai', 'Lane', 'Milan', 'Nico',
  'Priya', 'Mateo', 'Sofia', 'Hiro', 'Amara', 'Tomas', 'Leila', 'Omar', 'Ingrid', 'Kwame',
  'Lucia', 'Dmitri', 'Anika', 'Rafael', 'Mei', 'Tariq', 'Greta', 'Joaquin', 'Nadia', 'Felix',
];

export const LAST_NAMES = [
  'Ashford', 'Brennan', 'Calloway', 'Dunmore', 'Everly', 'Fairbanks', 'Galloway', 'Hollis', 'Ingram', 'Jessop',
  'Kittredge', 'Langley', 'Merriweather', 'Northcott', 'Okafor', 'Pemberton', 'Quill', 'Ravenscroft', 'Sutherland', 'Thorne',
  'Underhill', 'Vance', 'Whitlock', 'Yardley', 'Zeller', 'Alvarez', 'Bergstrom', 'Castellano', 'Delacroix', 'Eriksen',
  'Fitzgerald', 'Grisham', 'Haddad', 'Iwasaki', 'Jankowski', 'Kowalczyk', 'Lindqvist', 'Moreau', 'Nakamura', 'Oyelaran',
  'Petrakis', 'Rasmussen', 'Salazar', 'Takahashi', 'Ulrich', 'Varga', 'Winslow', 'Xiong', 'Yilmaz', 'Zamora',
];

export const BUSINESS_WORDS = [
  'Dental Group', 'Bakery', 'Fitness Studio', 'Veterinary Clinic', 'Law Offices', 'Coffee House', 'Auto Care',
  'Property Management', 'Brewing Co.', 'Montessori School', 'Family Pharmacy', 'Print Shop', 'Hardware',
  'Self Storage', 'Medical Plaza', 'Apartments', 'Diner', 'Yoga Loft', 'Daycare', 'Florist',
];

export const STREETS = [
  'Alder', 'Birch', 'Chestnut', 'Dogwood', 'Elm', 'Fir', 'Gingko', 'Hawthorn', 'Ironwood', 'Juniper',
  'Laurel', 'Magnolia', 'Oak', 'Pine', 'Quarry', 'Redwood', 'Spruce', 'Tamarack', 'Walnut', 'Willow',
  'Harbor', 'Summit', 'Canyon', 'Meadow', 'Ridge', 'Lakeview', 'Orchard', 'Prairie', 'Granite', 'Foundry',
];
export const STREET_SUFFIXES = ['St', 'Ave', 'Rd', 'Ln', 'Dr', 'Ct', 'Way', 'Pl', 'Blvd'];
