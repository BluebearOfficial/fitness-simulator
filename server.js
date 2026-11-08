const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs'); // 引入文件系统
const path = require('path');

const db = new Database('./fitness.db');
const app = express();;
// 必须放在 express.json() 之前！
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  // 如果是浏览器的预检请求（OPTIONS），直接返回 200 放行
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// ===== 存档引擎 =====
const FILE = './save.json';

// 初始化玩家（如果没有存档时的默认状态）
function createNewPlayer() {
  return {
    day: 1, age: 20, ap: 100, weight: 65,
    stats: { sprint: 10, run: 10, pullup: 0, jump: 10, lung: 10, sit: 0 },
    lastTrainDay: { sprint: 1, run: 1, pullup: 1, jump: 1, lung: 1, sit: 1 },
    maxTestScore: 0, honor: 0,
    fatigue: { sprint: 0, run: 0, pullup: 0, jump: 0, lung: 0, sit: 0 },
    supercompensation: { sprint: false, run: false, pullup: false, jump: false, lung: false, sit: false }
  };
}

let player = createNewPlayer();

// 启动时加载存档
if (fs.existsSync(FILE)) {
  const loadedData = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  player = { ...player, ...loadedData }; 
  
  // 🩹 兼容补丁：确保旧存档也拥有新的数据字段
  if (!player.fatigue) player.fatigue = { sprint: 0, run: 0, pullup: 0, jump: 0, lung: 0, sit: 0 };
  if (!player.supercompensation) player.supercompensation = { sprint: false, run: false, pullup: false, jump: false, lung: false, sit: false };
}

// 保存存档
function saveGame() {
  fs.writeFileSync(FILE, JSON.stringify(player, null, 2));
}


// ================= 游戏常量配置 =================
const TRAIN_AP_COST = 20;        // 每次训练消耗体力
const MAX_AP = 100;              // 每天满体力
const DECAY_RATE = 0.02;         // 不训练每天衰退 2%

// ================= 玩家内存存档（先不接数据库，跑通逻辑） =================
// 后续我们会把它替换成 SQLite 里的 player 表
/*let player = {
  day: 1,
  age: 20,
  ap: 100,
  weight: 65, // 初始 65kg (175cm)
  stats: {
    sprint: 10,   // 初始属性给一点点，不然永远0分
    run: 10,
    pullup: 0,
    jump: 10,
    lung: 10,
    sit: 0
  },
  // 记录各项上一次训练的天数，用于判断是否衰退
  lastTrainDay: {
    sprint: 1, run: 1, pullup: 1, jump: 1, lung: 1, sit: 1
  },
  // 历史体测最高分（用于退役结算）
  maxTestScore: 0
};*/

// ================= 核心工具函数 =================

// 1. 根据属性计算真实成绩（后续会精细化，现在先做个线性映射）
function calculateActualScore(statName, statValue) {
  if (statName === 'sprint') return 12.0 - (statValue * 0.05); // 秒，越少越好
  if (statName === 'run') return 400 - (statValue * 1.5);       // 秒，越少越好
  if (statName === 'pullup') return Math.floor(statValue * 0.5); // 个，越多越好
  if (statName === 'jump') return 150 + statValue;              // 厘米
  if (statName === 'lung') return 2000 + statValue * 20;        // 毫升
  if (statName === 'sit') return statValue * 0.5;               // 厘米
  return 0;
}

// 2. 计算当前 BMI
function calculateBMI(weight) {
  const heightM = 1.75; // 固定身高
  return weight / (heightM * heightM);
}

// ================= 接口 API =================

app.post('/api/train', (req, res) => {
  const { statName } = req.body;

  if (player.stats[statName] === undefined) {
    return res.json({ ok: false, msg: '没有这个训练项目' });
  }
  if (player.ap < TRAIN_AP_COST) {
    return res.json({ ok: false, msg: '体力不足，请结束今天' });
  }

  player.ap -= TRAIN_AP_COST;

  // 1. 算当前成绩和分数
  let currentActual = 0;
  if (statName === 'sprint') currentActual = 12.0 - (player.stats.sprint * 0.05);
  if (statName === 'run') currentActual = 400 - (player.stats.run * 1.5);
  if (statName === 'pullup') currentActual = Math.floor(player.stats.pullup * 0.5);
  if (statName === 'jump') currentActual = 150 + player.stats.jump;
  if (statName === 'lung') currentActual = 2000 + player.stats.lung * 20;
  if (statName === 'sit') currentActual = player.stats.sit * 0.5;

  let currentScore = getScoreFromDB(statName, currentActual);

  // 2. 软上限
  let gainMultiplier = 1.0;
  if (currentScore >= 80) gainMultiplier = 0.2;
  else if (currentScore >= 60) gainMultiplier = 0.5;

  // 3. 超量恢复判定
  let isSuperComp = false;
  if (player.supercompensation[statName]) {
    gainMultiplier *= 2; 
    isSuperComp = true;
    player.supercompensation[statName] = false; 
  }

  // 4. 结算属性
  const baseGain = 2;
  const finalGain = baseGain * gainMultiplier;
  player.stats[statName] += finalGain;
  player.fatigue[statName] += 30; 
  player.lastTrainDay[statName] = player.day;

  // 5. 体重联动
  if (statName === 'pullup') player.weight += 0.2 * gainMultiplier;
  if (statName === 'run') player.weight -= 0.2 * gainMultiplier;

  // 6. 存盘
  saveGame();

  // 7. 返回数据
  res.json({ 
    ok: true, 
    msg: isSuperComp ? `🔥 超量恢复触发！` : `${statName} 训练成功`, 
    ap: player.ap, 
    stats: player.stats,
    gain: finalGain.toFixed(2),
    currentScore: currentScore,
    isSuperComp
  });
});
// 结束今天，进入下一天
app.post('/api/next-day', (req, res) => {
  player.day += 1;
  player.ap = MAX_AP;
  
  let justReadyStats = []; // 用来收集刚刚触发了超量恢复的项目

  // 1. 检查是否有项目衰退（超过 7 天没练）
  for (const stat in player.stats) {
    if (player.day - player.lastTrainDay[stat] > 7) {
      player.stats[stat] = Math.max(0, player.stats[stat] * (1 - DECAY_RATE));
    }
  }

  // 2. 处理疲劳度和超量恢复 (💡 必须放在跨年 return 之前！)
  for (const stat in player.fatigue) {
    // 疲劳度衰减
    if (player.fatigue[stat] > 0) {
      player.fatigue[stat] -= 15;
      if (player.fatigue[stat] < 0) player.fatigue[stat] = 0;
    }
    
    // 判定超量恢复
    const daysSinceLastTrain = player.day - player.lastTrainDay[stat];
    if (player.fatigue[stat] === 0 && daysSinceLastTrain >= 2 && !player.supercompensation[stat]) {
      player.supercompensation[stat] = true;
      justReadyStats.push(stat); // 记录一下，告诉前端
    }
  }

  // 3. 检查是否跨年（365天）
  if (player.day % 365 === 0) {
    player.age += 1;
    
    const testResult = calculateAllScores();
    if (testResult.totalScore > player.maxTestScore) {
      player.maxTestScore = testResult.totalScore;
    }

    const earnedHonor = Math.floor(testResult.totalScore * 10);
    player.honor = (player.honor || 0) + earnedHonor;

    saveGame(); // 跨年也要存盘！
    return res.json({ 
      ok: true, 
      isNewYear: true, 
      day: player.day, 
      age: player.age,
      testResult: testResult, 
      earnedHonor: earnedHonor,
      justReadyStats: justReadyStats, // 把提示传过去
      msg: `年度体测结束！获得 ${earnedHonor} 荣誉点。`
    });
  }

  // 4. 检查是否到达 50 岁（退役）
  if (player.age >= 50) {
    saveGame();
    return res.json({ ok: true, isRetired: true, msg: '你已年满50，游戏结束' });
  }

  saveGame();

  // 最后返回普通状态
  res.json({ 
    ok: true, 
    day: player.day, 
    ap: player.ap, 
    stats: player.stats, 
    weight: player.weight,
    justReadyStats: justReadyStats // 把提示传过去
  });
});


// 查表函数：根据成绩和方向，去 SQLite 里找分数
function getScoreFromDB(item, actualScore) {
  let row;
  if (item === 'sprint' || item === 'run') {
    // 跑步类：越小越好。找大于等于成绩的最小值
    row = db.prepare('SELECT score FROM standards WHERE item = ? AND threshold >= ? ORDER BY threshold ASC LIMIT 1').get(item, actualScore);
  } else {
    // 跳跃/力量/肺活量等：越大越好。找小于等于成绩的最大值
    row = db.prepare('SELECT score FROM standards WHERE item = ? AND threshold <= ? ORDER BY threshold DESC LIMIT 1').get(item, actualScore);
  }
  // 如果查不到（达不到10分标准），直接给 0 分
  return row ? row.score : 0;
}

// 计算单项的最终得分（包含体测）和总分
function calculateAllScores() {
  // 1. 算各项真实成绩
   // 1. 算各项真实成绩（加入人类极限锁）
  const actuals = {
    // 50米极限 5.56 秒，最低不能跌破
    sprint: Math.max(5.56, 12.0 - (player.stats.sprint * 0.05)),
    
    // 1000米极限 131.96 秒（2分11.96秒），最低不能跌破
    run: Math.max(131.96, 400 - (player.stats.run * 1.5)),
    
    pullup: Math.floor(player.stats.pullup * 0.5),
    jump: 150 + player.stats.jump,
    lung: 2000 + player.stats.lung * 20,
    sit: player.stats.sit * 0.5
  };

  // 2. 查表得单项分数
  const scores = {
    sprint: getScoreFromDB('sprint', actuals.sprint),
    run: getScoreFromDB('run', actuals.run),
    pullup: getScoreFromDB('pullup', actuals.pullup),
    jump: getScoreFromDB('jump', actuals.jump),
    lung: getScoreFromDB('lung', actuals.lung),
    sit: getScoreFromDB('sit', actuals.sit)
  };

  // 3. 算 BMI 分数
  const bmi = calculateBMI(player.weight);
  let bmiScore = 0;
  if (bmi >= 17.9 && bmi <= 23.9) bmiScore = 100;
  else if (bmi >= 24.0 && bmi <= 27.9) bmiScore = 80;
  else if (bmi >= 28.0) bmiScore = 60;
  else if (bmi < 17.9) bmiScore = 80; // 太轻也给80

  // 4. 加权计算总分（按你之前定的权重：速度20%, 耐力20%, 引体10%, 跳远10%, 肺活量15%, 柔韧10%, BMI 15%）
  // 注意：因为你引体满分是200，速度满分150，这部分乘权重后，刚好能溢出
  const totalScore = 
    (scores.sprint * 0.20) +
    (scores.run * 0.20) +
    (scores.pullup * 0.10) +
    (scores.jump * 0.10) +
    (scores.lung * 0.15) +
    (scores.sit * 0.10) +
    (bmiScore * 0.15);

  return {
    actuals,
    scores,
    bmi,
    bmiScore,
    totalScore: Number(totalScore.toFixed(2)) // 保留两位小数
  };
}


app.post('/api/reset', (req, res) => {
  player = createNewPlayer();
  saveGame();
  res.json({ ok: true, msg: '人生已重启' });
});

app.get('/api/status', (req, res) => {
  const scoreData = calculateAllScores(); 
  
  res.json({
    day: player.day,
    age: player.age,
    ap: player.ap,
    weight: player.weight.toFixed(2),
    bmi: scoreData.bmi.toFixed(2),
    stats: player.stats,
    estimatedScores: scoreData.scores,
    estimatedTotal: scoreData.totalScore,
    bmiScore: scoreData.bmiScore,
    actuals: scoreData.actuals // <--- 新增这行，把真实成绩传过去！
  });
});



app.listen(3000, () => {
  console.log('🏃 体测模拟器后端已启动：http://localhost:3000');
});