const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// 允许跨域，方便前端直接双击打开测试
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const db = new Database('./fitness.db');
const FILE = './save.json';

// ================= 游戏常量配置 =================
const MAX_AP_MENTAL = { work: 20, rest: 100 };
const MAX_AP_PHYSICAL = { work: 10, rest: 60 };
const PHYSICAL_FATIGUE_PER_DAY = 15;
const FATIGUE_RECOVER_PER_DAY = 15;
const OVERTRAIN_THRESHOLD = 60;
const DECAY_RATE = 0.02;
const DECAY_DAYS = 14;
const JOB_CHANGE_COST = 1500;
const MENTAL_SALARY = 2500;
const PHYSICAL_SALARY = 4000;


// 辅助函数：强制保留两位小数，四舍五入，避免浮点数精度问题
function roundMoney(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}
// ================= 玩家初始化 =================
function createNewPlayer() {
  return {
    day: 1,
    age: 20,
    job: 'mental', // 'mental' 或 'physical'
    money: 2000,
    bank: 0,
    stats: { sprint: 10, run: 10, pullup: 0, jump: 10, lung: 10, sit: 0 },
    weight: 65, // 初始体重
    fatigue: { sprint: 0, run: 0, pullup: 0, jump: 0, lung: 0, sit: 0 },
    lastTrainDay: { sprint: 1, run: 1, pullup: 1, jump: 1, lung: 1, sit: 1 },
    maxTestScore: 0
  };
}

let player = createNewPlayer();

// 加载存档
if (fs.existsSync(FILE)) {
  const loadedData = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  player = { ...player, ...loadedData };
}

function saveGame() {
  fs.writeFileSync(FILE, JSON.stringify(player, null, 2));
}

// ================= 核心工具函数 =================

// 查表引擎（0分兜底）
function getScoreFromDB(item, actualScore) {
  let row;
  if (item === 'sprint' || item === 'run') {
    row = db.prepare('SELECT score FROM standards WHERE item = ? AND threshold >= ? ORDER BY threshold ASC LIMIT 1').get(item, actualScore);
  } else {
    row = db.prepare('SELECT score FROM standards WHERE item = ? AND threshold <= ? ORDER BY threshold DESC LIMIT 1').get(item, actualScore);
  }
  return row ? row.score : 0;
}

// 真实成绩计算（含人类极限锁）
function calculateAllScores() {
  const actuals = {
    sprint: Math.max(5.56, 12.0 - (player.stats.sprint * 0.05)),
    run: Math.max(131.96, 400 - (player.stats.run * 1.5)),
    pullup: Math.floor(player.stats.pullup * 0.5),
    jump: 150 + player.stats.jump,
    lung: 2000 + player.stats.lung * 20,
    sit: player.stats.sit * 0.5
  };

  const scores = {
    sprint: getScoreFromDB('sprint', actuals.sprint),
    run: getScoreFromDB('run', actuals.run),
    pullup: getScoreFromDB('pullup', actuals.pullup),
    jump: getScoreFromDB('jump', actuals.jump),
    lung: getScoreFromDB('lung', actuals.lung),
    sit: getScoreFromDB('sit', actuals.sit)
  };

  // BMI 计算
  const bmi = player.weight / (1.75 * 1.75);
  let bmiScore = 0;
  if (bmi >= 17.9 && bmi <= 23.9) bmiScore = 100;
  else if (bmi >= 24.0 && bmi <= 27.9) bmiScore = 80;
  else if (bmi >= 28.0) bmiScore = 60;
  else if (bmi < 17.9) bmiScore = 80;

  // 加权总分计算
  const totalScore = 
    (scores.sprint * 0.20) + (scores.run * 0.20) + 
    (scores.pullup * 0.10) + (scores.jump * 0.10) + 
    (scores.lung * 0.15) + (scores.sit * 0.10) + 
    (bmiScore * 0.15);

  return { actuals, scores, bmi, bmiScore, totalScore: Number(totalScore.toFixed(2)) };
}

// ================= API 接口 =================

// 获取状态

app.get('/api/status', (req, res) => {
  const scoreData = calculateAllScores();
  res.json({
    day: player.day,
    age: player.age,
    job: player.job,
    money: Number(player.money.toFixed(2)),
    bank: Number(player.bank.toFixed(2)),
    ap: player.ap || 0,
    weight: player.weight.toFixed(2),
    bmi: scoreData.bmi.toFixed(2),
    stats: player.stats,
    fatigue: player.fatigue, // ?? 新增：把疲劳值发给前端
    actuals: scoreData.actuals,
    estimatedScores: scoreData.scores, // 包含所有项的真实得分
    estimatedTotal: scoreData.totalScore
  });
});
// 训练接口（含软上限与过度训练惩罚）
app.post('/api/train', (req, res) => {
  const { statName } = req.body;
  if (player.stats[statName] === undefined) return res.json({ ok: false, msg: '没有这个训练项目' });
  
  // 判定当前体力（前端传或后端算，这里简化为前端控制，后端仅校验基础）
  if (!player.ap || player.ap < 10) return res.json({ ok: false, msg: '体力不足，请结束今天' });

  player.ap -= 10; // 统一扣10点体力

  // 1. 查表得分数（用于判定软上限）
  let currentActual = 0;
  if (statName === 'sprint') currentActual = 12.0 - (player.stats.sprint * 0.05);
  if (statName === 'run') currentActual = 400 - (player.stats.run * 1.5);
  if (statName === 'pullup') currentActual = Math.floor(player.stats.pullup * 0.5);
  if (statName === 'jump') currentActual = 150 + player.stats.jump;
  if (statName === 'lung') currentActual = 2000 + player.stats.lung * 20;
  if (statName === 'sit') currentActual = player.stats.sit * 0.5;
  let currentScore = getScoreFromDB(statName, currentActual);

  // 2. 软上限倍率
  let gainMultiplier = 1.0;
  if (currentScore >= 80) gainMultiplier = 0.2;
  else if (currentScore >= 60) gainMultiplier = 0.5;

  // 3. 过度训练惩罚判定
  let isOvertrained = false;
  if (player.fatigue[statName] >= OVERTRAIN_THRESHOLD) {
    isOvertrained = true;
  }

  let finalGain = 2 * gainMultiplier;
  if (isOvertrained) finalGain = -1; // 负收益

  player.stats[statName] += finalGain;
  if (player.stats[statName] < 0) player.stats[statName] = 0; // 防止属性变负

  // 4. 积累疲劳
  player.fatigue[statName] += 30;
  player.lastTrainDay[statName] = player.day;

  // 5. 体重联动
  if (statName === 'pullup' && !isOvertrained) player.weight += 0.2 * gainMultiplier;
  if (statName === 'run' && !isOvertrained) player.weight -= 0.2 * gainMultiplier;

  saveGame();
  res.json({ 
    ok: true, 
    msg: isOvertrained ? '💥 严重警告：过度训练！肌肉拉伤，属性下降！' : '训练成功',
    gain: finalGain.toFixed(2),
    isOvertrained,
    ap: player.ap
  });
});

// 结束今天（核心经济与体力引擎）
app.post('/api/next-day', (req, res) => {
  player.day += 1;

  // ===== 1. 日历判定（28天/月，每月第4周长假） =====
  const dayOfMonth = player.day % 28 === 0 ? 28 : player.day % 28;
  const dayOfWeek = player.day % 7 === 0 ? 7 : player.day % 7;

  let isRestDay = false;
  let isHolidayWeek = (dayOfMonth >= 22 && dayOfMonth <= 28);

  if (isHolidayWeek) {
    isRestDay = (dayOfWeek >= 4); // 上三休四
  } else {
    isRestDay = (dayOfWeek === 6 || dayOfWeek === 7); // 正常周末
  }

  // ===== 2. 动态生活费扣除（max(50, 资产*0.2%)） =====
  const totalAssets = player.money + player.bank;
  const dailyExpense = Math.max(50, totalAssets * 0.002);
  player.money -= dailyExpense;
  
  if (player.money < 0) {
    return res.json({ ok: false, isGameOver: true, msg: `💸 破产！你连 ${dailyExpense.toFixed(2)} 元的生活费都交不起了。` });
  }


 // ===== 2. 银行利息结算 =====
  let interestEarned = 0;
  if (player.bank > 0) {
    // 每天 0.02% 复利
    interestEarned = roundMoney(player.bank * 0.0002);
    player.bank = roundMoney(player.bank + interestEarned);
  }

  // ===== 3. 发薪日与体力恢复 =====
  let salaryMsg = '';
  if (dayOfMonth === 28) {
    const salary = player.job === 'mental' ? MENTAL_SALARY : PHYSICAL_SALARY;
    player.money += salary;
    salaryMsg = `💰 发工资啦！获得 ${salary} 元。`;
  }

  // 判定体力上限
  let maxAp = 0;
  if (player.job === 'mental') {
    maxAp = isRestDay ? MAX_AP_MENTAL.rest : MAX_AP_MENTAL.work;
  } else {
    maxAp = isRestDay ? MAX_AP_PHYSICAL.rest : MAX_AP_PHYSICAL.work;
  }
  player.ap = maxAp;

  // ===== 4. 工作带来的疲劳与被动成长 =====
  let workMsg = '';
  if (!isRestDay && player.job === 'physical') {
    player.stats.pullup += 0.2;
    player.stats.run += 0.2;
    player.fatigue.pullup += PHYSICAL_FATIGUE_PER_DAY;
    player.fatigue.run += PHYSICAL_FATIGUE_PER_DAY;
    workMsg = '📦 你今天干了繁重的体力活，力量/耐力微增，但身体更加疲惫了。';
  }

  // ===== 5. 疲劳恢复与超量恢复判定 =====
  let readyStats = [];
  for (const stat in player.fatigue) {
    if (player.lastTrainDay[stat] !== player.day) {
      player.fatigue[stat] -= FATIGUE_RECOVER_PER_DAY;
      if (player.fatigue[stat] < 0) player.fatigue[stat] = 0;
    }
    // 判定超量恢复（这里简化为疲劳归零且超过2天没练）
    if (player.fatigue[stat] === 0 && (player.day - player.lastTrainDay[stat] >= 2)) {
      // 如果前端需要提示，可以在这里记录下来
    }
  }

  // ===== 6. 衰退判定（14天不练） =====
  for (const stat in player.stats) {
    if (player.day - player.lastTrainDay[stat] > DECAY_DAYS) {
      player.stats[stat] = Math.max(0, player.stats[stat] * (1 - DECAY_RATE));
    }
  }

  // ===== 7. 跨年体测（336天） =====
  let yearMsg = '';
  let testResult = null;
  if (player.day % 336 === 0) {
    player.age += 1;
    const scores = calculateAllScores();
    testResult = scores;

    // 年终奖计算（速算扣除数）
    let honor = 0;
    const t = scores.totalScore;
    if (t < 50) honor = 0;
    else if (t < 60) honor = Math.floor(t * 10 - 500);
    else if (t < 70) honor = Math.floor(t * 20 - 1100);
    else if (t < 80) honor = Math.floor(t * 40 - 2500);
    else if (t < 90) honor = Math.floor(t * 70 - 4900);
    else if (t < 100) honor = Math.floor(t * 100 - 7600);
    else honor = Math.floor(t * 200 - 17600);

    const bonusMoney = honor * 10;
    player.money += bonusMoney;
    yearMsg = `🎉 年度体测结束！总分 ${t} 分，获得年终奖 ${bonusMoney} 元！`;
  }

  saveGame();
  
  res.json({
    ok: true,
    day: player.day,
    isRestDay,
    isHolidayWeek,
    ap: player.ap,
    money: Number(player.money.toFixed(2)),
    msg: `${salaryMsg} ${workMsg} ${yearMsg}`.trim() || (isRestDay ? '🏖️ 今天是休息日。' : '💻 今天是工作日。'),
    testResult
  });
});

// 换工作
app.post('/api/change-job', (req, res) => {
  const { newJob } = req.body;
  if (player.job === newJob) return res.json({ ok: false, msg: '你已经在从事这份工作了' });

  if (newJob === 'physical' && (player.stats.pullup < 20 || player.stats.run < 20)) {
    return res.json({ ok: false, msg: '体力劳动入职失败：你的力量或耐力未达到门槛(20)' });
  }

  if (player.money < JOB_CHANGE_COST) {
    return res.json({ ok: false, msg: `连 ${JOB_CHANGE_COST} 元的安置费都交不起。` });
  }

  player.money -= JOB_CHANGE_COST;
  player.job = newJob;
  player.ap = 0; // 跑面试耗尽体力
  saveGame();
  res.json({ ok: true, msg: `成功入职新工作！扣除安置费 ${JOB_CHANGE_COST} 元。`, job: player.job });
});

// ===== 银行系统 =====
app.post('/api/bank/deposit', (req, res) => {
  const amount = roundMoney(req.body.amount); // 👈 强制两位小数
  if (amount <= 0 || amount > player.money) return res.json({ ok: false, msg: '金额非法' });
  player.money = roundMoney(player.money - amount);
  player.bank = roundMoney(player.bank + amount);
  saveGame();
  res.json({ ok: true, msg: '存款成功' });
});

app.post('/api/bank/withdraw', (req, res) => {
  const { amount } = req.body;
  if (amount <= 0 || amount > player.bank) return res.json({ ok: false, msg: '金额非法' });
  player.bank -= amount;
  player.money += amount;
  saveGame();
  res.json({ ok: true, msg: '取款成功' });
});

app.listen(3000, () => {
  console.log('🏃 赛博社畜体测模拟器后端已启动：http://localhost:3000');
});