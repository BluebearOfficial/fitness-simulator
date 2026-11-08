const Database = require('better-sqlite3');
const fs = require('fs');

// 如果已经有数据库，先删掉重新建（注意：以后真的开始玩的时候，千万别随便删）
if (fs.existsSync('./fitness.db')) {
  fs.unlinkSync('./fitness.db');
}

const db = new Database('./fitness.db');

// 创建标准表
db.exec(`
  CREATE TABLE standards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL,
    score INTEGER NOT NULL,
    threshold REAL NOT NULL,
    is_higher_better INTEGER NOT NULL
  );
`);

// 你的原始数据
const rawData = `
sprint, 100, 6.6
sprint, 95, 6.7
sprint, 90, 6.8
sprint, 85, 6.9
sprint, 80, 7.0
sprint, 78, 7.2
sprint, 76, 7.4
sprint, 74, 7.6
sprint, 72, 7.8
sprint, 70, 8.0
sprint, 68, 8.2
sprint, 66, 8.4
sprint, 64, 8.6
sprint, 62, 8.8
sprint, 60, 9.0
sprint, 50, 9.2
sprint, 40, 9.4
sprint, 30, 9.6
sprint, 20, 9.8
sprint, 10, 10.0
run, 150, 160
run, 145, 163
run, 140, 166
run, 135, 169
run, 130, 172
run, 125, 175
run, 120, 179
run, 115, 183
run, 110, 187
run, 105, 191
run, 100, 195
run, 95, 200
run, 90, 205
run, 85, 212
run, 80, 220
run, 78, 225
run, 76, 230
run, 74, 235
run, 72, 240
run, 70, 245
run, 68, 250
run, 66, 255
run, 64, 260
run, 62, 265
run, 60, 270
run, 50, 290
run, 40, 310
run, 30, 330
run, 20, 350
run, 10, 370
pullup, 200, 30
pullup, 190, 29
pullup, 180, 28
pullup, 170, 27
pullup, 160, 26
pullup, 150, 25
pullup, 140, 24
pullup, 130, 23
pullup, 120, 22
pullup, 110, 21
pullup, 100, 20
pullup, 95, 19
pullup, 90, 18
pullup, 85, 17
pullup, 80, 16
pullup, 76, 15
pullup, 72, 14
pullup, 68, 13
pullup, 64, 12
pullup, 60, 11
pullup, 50, 10
pullup, 40, 9
pullup, 30, 8
pullup, 20, 7
pullup, 10, 6
jump, 100, 275
jump, 95, 270
jump, 90, 265
jump, 85, 258
jump, 80, 250
jump, 78, 246
jump, 76, 242
jump, 74, 238
jump, 72, 234
jump, 70, 230
jump, 68, 226
jump, 66, 222
jump, 64, 218
jump, 62, 214
jump, 60, 210
jump, 50, 205
jump, 40, 200
jump, 30, 195
jump, 20, 190
jump, 10, 185
lung, 100, 5140
lung, 95, 5020
lung, 90, 4900
lung, 85, 4650
lung, 80, 4400
lung, 78, 4280
lung, 76, 4160
lung, 74, 4040
lung, 72, 3920
lung, 70, 3800
lung, 68, 3680
lung, 66, 3560
lung, 64, 3440
lung, 62, 3320
lung, 60, 3200
lung, 50, 3030
lung, 40, 2860
lung, 30, 2690
lung, 20, 2520
lung, 10, 2350
sit, 100, 25.1
sit, 95, 23.3
sit, 90, 21.5
sit, 85, 19.9
sit, 80, 18.2
sit, 78, 16.8
sit, 76, 15.4
sit, 74, 14.0
sit, 72, 12.6
sit, 70, 11.2
sit, 68, 9.8
sit, 66, 8.4
sit, 64, 7.0
sit, 62, 5.6
sit, 60, 4.2
sit, 50, 3.2
sit, 40, 2.2
sit, 30, 1.2
sit, 20, 0.2
sit, 10, -0.8
`;

// 解析并插入
const insert = db.prepare(`
  INSERT INTO standards (item, score, threshold, is_higher_better)
  VALUES (?, ?, ?, ?)
`);

const insertMany = db.transaction((lines) => {
  for (const line of lines) {
    if (!line.trim()) continue;
    const [item, scoreStr, thresholdStr] = line.split(',').map(s => s.trim());
    const score = Number(scoreStr);
    const threshold = Number(thresholdStr);
    
    // 判定是越大越好还是越小越好
    let is_higher_better = 1;
    if (item === 'sprint' || item === 'run') {
      is_higher_better = 0;
    }
    
    insert.run(item, score, threshold, is_higher_better);
  }
});

// 过滤掉空行
const lines = rawData.split('\n').filter(line => line.trim() !== '');
insertMany(lines);

console.log(`✅ 成功导入 ${lines.length} 条体测标准数据！`);
db.close();