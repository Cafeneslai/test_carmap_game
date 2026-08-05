<div align="center">

# 🌍 Car GameWorld
**Real-Time Procedural World Generation Driving Game**

[![Three.js](https://img.shields.io/badge/Three.js-black?style=for-the-badge&logo=three.js&logoColor=white)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E)](https://vitejs.dev/)
[![OpenStreetMap](https://img.shields.io/badge/OpenStreetMap-7EBC6F?style=for-the-badge&logo=OpenStreetMap&logoColor=white)](https://www.openstreetmap.org/)
[![Cannon-es](https://img.shields.io/badge/Physics-Cannon.js-blue?style=for-the-badge)](https://pmndrs.github.io/cannon-es/)
[![Leaflet](https://img.shields.io/badge/Map-Leaflet.js-green?style=for-the-badge)](https://leafletjs.com/)

เกมขับรถ 3D ที่สร้างโลกเสมือนจริงขึ้นมาแบบ Real-Time จากข้อมูลแผนที่ **OpenStreetMap** และ **Open Topo Data** สามารถเลือกสถานที่ใดก็ได้บนโลกผ่านแผนที่ Interactive เพื่อเข้าไปขับรถสำรวจถนน ภูเขา อาคาร และแม่น้ำได้อย่างอิสระ!

</div>

---

## ✨ ฟีเจอร์หลัก (Key Features)

- 🗺️ **Procedural Generation:** สร้างตึก ถนน ต้นไม้ และแม่น้ำแบบสดๆ จากข้อมูลจริงของโลก (OSM)
- ⛰️ **Real Elevation (DEM):** ภูมิประเทศมีความสูงต่ำสมจริง อ้างอิงจากข้อมูลระดับน้ำทะเล (SRTM)
- 🚗 **Raycast Vehicle Physics:** ระบบฟิสิกส์รถยนต์ที่สมจริง รองรับระบบโช้ค การเบรก แรงเสียดทาน และเบรคมือ (Cannon-es)
- 🌍 **Interactive Map Picker:** เลื่อนแผนที่จิ้มปักหมุดจุดเริ่มต้นได้ทั่วโลกด้วย Leaflet.js
- ⚡ **Chunk Streaming System:** โหลดเฉพาะส่วนที่ผู้เล่นมองเห็น (Chunk) ช่วยลดการใช้ RAM และเพิ่ม FPS

---

## 🚀 การติดตั้งและใช้งาน (Installation)

โปรเจกต์นี้ทำงานด้วย Node.js และแพ็กเกจจัดการโมดูลแบบ Vite

### ข้อกำหนดระบบ
- **Node.js** (v16+)
- **Git**

### ขั้นตอนติดตั้ง
1. โคลน Repository นี้:
   ```bash
   git clone https://github.com/yourusername/car_gameworld.git
   cd car_gameworld
   ```
2. ติดตั้ง Dependencies (Three.js, Cannon-es, Leaflet):
   ```bash
   npm install
   ```
3. เปิด Development Server:
   ```bash
   npm run dev
   ```
   > 🌐 **เปิด Browser ไปที่:** `http://localhost:3000`

---

## 🎮 วิธีการเล่น (How to Play)

### 1. เลือกสถานที่
ในหน้าแรกคุณสามารถ **ค้นหาชื่อเมือง** หรือ **จิ้มบนแผนที่แบบ Interactive** เพื่อปักหมุดจุดเริ่มต้น หากต้องการทดสอบอย่างรวดเร็ว สามารถกดเลือกจาก "สถานที่แนะนำ" (Presets) ได้ทันที จากนั้นกดปุ่ม **🚗 Start Driving**

### 2. ปุ่มควบคุม
| ปุ่ม | การกระทำ |
|:---:|:---|
| `W` / `↑` | เร่งเครื่อง (คันเร่ง) |
| `S` / `↓` | ถอยหลัง / เบรก |
| `A` / `D` | เลี้ยวซ้าย / ขวา |
| `Space` | เบรคมือ (Handbrake / ดริฟท์) |
| `C` | เปลี่ยนมุมกล้อง (Third-Person, Bird's Eye, Hood) |
| `R` | รีเซ็ตตำแหน่งรถ (ในกรณีที่พลิกคว่ำหรือติดหล่ม) |
| `ESC` | เปิดหน้าต่างตั้งค่ากราฟิก (Settings) |

---

## 🏗️ สถาปัตยกรรม (Architecture)

1. **OSM Fetcher & Elevation Fetcher:** 
   ดึงข้อมูลจุดพิกัดผ่าน `Overpass API` และความสูงจาก `Open Topo Data` แบบ Asynchronous
2. **Chunk Manager:** 
   ทำงานร่วมกับ `WorldBuilder` เพื่อ Generate วัตถุแบบ Grid 200x200m และทยอยโหลด/ลบทิ้ง (Dispose) เพื่อจัดการ Memory
3. **Vehicle & Camera Controller:** 
   แปลง Input เป็นค่าแรงทางฟิสิกส์ให้ `Cannon-es` และสั่งกล้องให้ติดตามรถแบบ Interpolation อย่างนุ่มนวล

---

## 🛠️ การตั้งค่าเพิ่มเติม (Configuration)

หากต้องการปรับจูนตัวแปรของเกม (เช่น ความแรงรถ ขนาดของโลก ฯลฯ) สามารถเข้าไปแก้ไขได้ที่ `src/config.js`
- `CHUNK_SIZE`: ขนาดของแต่ละพื้นที่ (Default: 200 เมตร)
- `VIEW_DISTANCE`: ระยะสายตา (Default: 3 Chunks = รัศมี 600 เมตร)
- `CAR_MAX_FORCE`: แรงบิดของเครื่องยนต์

---

## 📝 License

โปรเจกต์นี้เปิดให้ใช้งานและแก้ไขได้อย่างอิสระ (Open Source) 
- ข้อมูลแผนที่สนับสนุนโดย [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL)
- ข้อมูลระดับความสูงสนับสนุนโดย [Open Topo Data](https://www.opentopodata.org/)
