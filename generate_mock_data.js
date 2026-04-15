const fs = require('fs');
const path = require('path');

function generateMockEDF(filePath, fileName, hasSeizure) {
  const ns = 23;
  const numRecords = 20;
  const header = Buffer.alloc(256 + ns * 256, 32); // fill with spaces

  // Fixed header
  header.write('0       ', 0); // version
  header.write('MockPatient                             ', 8);
  header.write('MockRecording                           ', 88);
  header.write('01.01.23', 168); // date
  header.write('12.00.00', 176); // time
  header.write(String(256 + ns * 256).padEnd(8), 184); // header length
  header.write('        ', 192); // reserved
  header.write(String(numRecords).padEnd(8), 236); // number of data records
  header.write('1       ', 244); // duration of data record
  header.write(String(ns).padEnd(4), 252); // number of signals

  // Signal headers
  for (let i = 0; i < ns; i++) {
    const label = `CH${i + 1}`.padEnd(16);
    header.write(label, 256 + i * 16);
    header.write('Digital '.padEnd(80), 256 + ns * 16 + i * 80); // transducer
    header.write('uV      '.padEnd(8), 256 + ns * 96 + i * 8); // units
    header.write('-500    '.padEnd(8), 256 + ns * 104 + i * 8); // phys min
    header.write('500     '.padEnd(8), 256 + ns * 112 + i * 8); // phys max
    header.write('-32768  '.padEnd(8), 256 + ns * 120 + i * 8); // dig min
    header.write('32767   '.padEnd(8), 256 + ns * 128 + i * 8); // dig max
    header.write('        '.padEnd(80), 256 + ns * 136 + i * 80); // prefiltering
    header.write('256     '.padEnd(8), 256 + ns * 216 + i * 8); // samples per record
    header.write('        '.padEnd(32), 256 + ns * 224 + i * 32); // reserved
  }

  // Data
  const data = Buffer.alloc(ns * 256 * numRecords * 2);
  for (let r = 0; r < numRecords; r++) {
    for (let ch = 0; ch < ns; ch++) {
      for (let s = 0; s < 256; s++) {
        let val = Math.sin(s / 5) * 500;
        if (hasSeizure && r >= 5 && r <= 15) {
          val = (Math.random() - 0.5) * 20000;
        }
        const offset = (r * ns * 256 + ch * 256 + s) * 2;
        data.writeInt16LE(Math.max(-32768, Math.min(32767, val)), offset);
      }
    }
  }

  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

const testDir = 'test_data';
const pDir = path.join(testDir, 'participant_01');
if (!fs.existsSync(pDir)) fs.mkdirSync(pDir, { recursive: true });

generateMockEDF(path.join(pDir, 'test_01.edf'), 'test_01.edf', true);
generateMockEDF(path.join(pDir, 'test_02.edf'), 'test_02.edf', false);

const summary = `
File Name: test_01.edf
Number of Seizures in File: 1
Seizure 1 Start Time: 5 seconds
Seizure 1 End Time: 15 seconds

File Name: test_02.edf
Number of Seizures in File: 0
`;

fs.writeFileSync(path.join(pDir, 'summary.txt'), summary);
console.log('Mock data generated in test_data/');
