/**
 * config.js — ค่าคงที่ทั้งหมดของเกม
 */

// ====== World / Chunk ======
export const CHUNK_SIZE = 200;           // meters per chunk side
export const VIEW_DISTANCE = 3;          // chunks radius to load
export const INITIAL_VIEW_DISTANCE = 1.5; // radius in chunks built before play: 1.5 = the full 3x3 block (600 m); 1 would only give a plus shape
export const MAX_CONCURRENT_LOADS = 4;   // max chunks loading at once
export const CHUNK_UNLOAD_BUFFER = 1;    // extra chunk buffer before unload

// ====== Terrain ======
export const TERRAIN_RESOLUTION = 8;     // elevation vertices per chunk side (8x8 = 64 points, fast and smooth)
export const TERRAIN_Y_SCALE = 1;        // elevation multiplier

// ====== Roads ======
export const ROAD_Y_OFFSET = 0.05;       // meters above terrain
export const ROAD_WIDTHS = {
  motorway: 14,
  motorway_link: 8,
  trunk: 12,
  trunk_link: 7,
  primary: 10,
  primary_link: 6,
  secondary: 8,
  secondary_link: 5,
  tertiary: 7,
  tertiary_link: 5,
  residential: 6,
  unclassified: 5,
  service: 4,
  living_street: 5,
  pedestrian: 3,
  footway: 2,
  cycleway: 2,
  path: 1.5,
  track: 3,
};

// ====== Buildings ======
export const DEFAULT_BUILDING_HEIGHT = 9;   // meters (3 floors)
export const METERS_PER_FLOOR = 3;

// ====== Vegetation ======
export const TREE_DENSITY = 0.015;        // trees per square meter in forest
export const MAX_TREES_PER_CHUNK = 200;

// ====== Car / Physics ======
export const CAR_MASS = 1500;             // kg
export const CAR_MAX_FORCE = 1900;        // engine force per wheel (4WD)
export const CAR_MAX_BRAKE = 60;          // brake impulse per wheel
export const CAR_MAX_STEER = 0.55;        // radians at standstill (reduced at speed)
export const CAR_MAX_SPEED_KMH = 140;     // engine power fades out towards this speed
export const CAR_MAX_REVERSE_KMH = 35;
export const PHYSICS_STEP = 1 / 60;
export const CAR_DIMENSIONS = { x: 2, y: 1.2, z: 4.5 };

// ====== Camera ======
export const CAMERA_FOV = 60;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 2000;
export const CAMERA_OFFSET = { x: 0, y: 5, z: -12 };
export const CAMERA_LOOK_AHEAD = 5;
export const CAMERA_DAMPING = 0.05;

// ====== API Endpoints ======
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const NOMINATIM_API = 'https://nominatim.openstreetmap.org/search';
export const OSM_MAP_API = 'https://api.openstreetmap.org/api/0.6/map';
// Open building footprints (OSM + Google + Microsoft) fill the gaps where OSM has no buildings
export const OVERTURE_CATALOG = 'https://stac.overturemaps.org/catalog.json';
// Free aerial imagery for the ground (attribution: Esri, Maxar, Earthstar Geographics)
export const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
// Free current weather, no API key
export const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

// ====== Map tiles (first = primary, rest = fallbacks used when tiles fail to load) ======
// CARTO basemaps now return an "API KEY REQUIRED" watermark, so they are not used.
export const TILE_LAYERS = {
  dark: [
    {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      options: { maxNativeZoom: 16, maxZoom: 19, attribution: 'Tiles &copy; Esri' },
    },
    {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxNativeZoom: 19, maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' },
    },
  ],
  street: [
    {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxNativeZoom: 19, maxZoom: 19, attribution: 'Tiles &copy; Esri' },
    },
    {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxNativeZoom: 19, maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' },
    },
  ],
};
export const ELEVATION_API = 'https://api.opentopodata.org/v1/srtm30m';
export const OPEN_METEO_ELEVATION_API = 'https://api.open-meteo.com/v1/elevation';

// ====== Rate Limiting ======
export const OSM_REQUEST_INTERVAL = 800;   // ms between OSM requests
export const ELEVATION_REQUEST_INTERVAL = 100;

// ====== Cache ======
export const CACHE_DB_NAME = 'car_gameworld_cache';
export const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

// ====== Preset Locations ======
export const PRESET_LOCATIONS = [
  { name: '🏖️ บางแสน, ชลบุรี', lat: 13.2836, lng: 100.9268 },
  { name: '🗼 Tokyo Tower, Japan', lat: 35.6586, lng: 139.7454 },
  { name: '🗽 Manhattan, New York', lat: 40.7580, lng: -73.9855 },
  { name: '🏰 Paris, France', lat: 48.8584, lng: 2.2945 },
  { name: '🌉 San Francisco, USA', lat: 37.8199, lng: -122.4783 },
  { name: '🕌 กรุงเทพมหานคร', lat: 13.7563, lng: 100.5018 },
  { name: '🏔️ Chiang Mai, Thailand', lat: 18.7883, lng: 98.9853 },
  { name: '🌸 Kyoto, Japan', lat: 35.0116, lng: 135.7681 },
];

// ====== Game States ======
export const GAME_STATES = {
  LOCATION_SELECT: 'LOCATION_SELECT',
  LOADING: 'LOADING',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
};
