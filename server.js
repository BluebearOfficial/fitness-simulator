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
// ===== 商城商品配置 =====
const SHOP_ITEMS = {
  cheapRent: { name: '🏠 市郊廉价租房', price: 1000, desc: '基础生活费降至 30 元/天。' },
  earplugs: { name: '📱 降噪隔音耳塞', price: 1200, desc: '每日体力上限 +5。' },
  exoskeleton: { name: '🦿 外骨骼护腿', price: 2000, desc: '体力劳动每日工作疲劳降为 10。' },
  energyDrink: { name: '☕ 赛博浓缩液', price: 500, desc: '立刻清除所有疲劳（消耗品）。' }
};

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
    maxTestScore: 0,
        inventory: {
      cheapRent: false,
      earplugs: false,
      exoskeleton: false,
      energyDrink: 0 // 消耗品
    },
        sickPoints: 0,           // 病根值
    hospitalizedDays: 0,     // 住院剩余天数
   
        sickLeaveLight: false, // 主动就医标记
    sickLeaveHeavy: false, // 强制送医标记
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
    estimatedTotal: scoreData.totalScore,
    sickPoints: player.sickPoints || 0,      // 👈 加上这个
    hospitalizedDays: player.hospitalizedDays || 0 // 👈 加上这个
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

    // 3. 软上限倍率 + 病根衰减
 if (player.sickPoints > 0) {
    const sickPenalty = Math.max(0.5, 1 - (player.sickPoints / 2000));
    gainMultiplier *= sickPenalty;
  }



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

app.post('/api/next-day', (req, res) => {
  player.day += 1;
  
  // 1. 扣除每日动态生活费
  const totalAssets = player.money + player.bank;
  const baseRent = (player.inventory && player.inventory.cheapRent) ? 30 : 50;
  const dailyExpense = roundMoney(Math.max(baseRent, totalAssets * 0.002));
  player.money = roundMoney(player.money - dailyExpense);
  
  if (player.money < 0) {
    return res.json({ ok: false, isGameOver: true, msg: `💸 破产！你连 ${dailyExpense.toFixed(2)} 元的生活费都交不起了。` });
  }

  let msg = '';

  // ===== 2. 状态分流：住院中 vs 正常 =====
  if (player.hospitalizedDays > 0) {
    player.hospitalizedDays -= 1;
    player.ap = 0;
    msg = `🏥 你还在住院休养，剩余 ${player.hospitalizedDays} 天。`;

    // 住院期间恢复疲劳
    for (const stat in player.fatigue) {
      player.fatigue[stat] = Math.max(0, player.fatigue[stat] - 15);
    }

    // 住院期间遇到发薪日，结算病假工资
    if (player.day % 28 === 0) {
      const baseSalary = player.job === 'mental' ? MENTAL_SALARY : PHYSICAL_SALARY;
      let finalSalary = baseSalary;
      
      if (player.sickLeaveHeavy) {
        finalSalary = Math.floor(baseSalary * 0.5);
        msg += ` 💰 发工资（因重症住院折半）：获得 ${finalSalary} 元。`;
        player.sickLeaveHeavy = false;
      } else if (player.sickLeaveLight) {
        finalSalary = Math.floor(baseSalary * 0.9);
        msg += ` 💰 发工资（因病假扣除10%）：获得 ${finalSalary} 元。`;
        player.sickLeaveLight = false;
      } else {
        msg += ` 💰 发工资：获得 ${finalSalary} 元。`;
      }
      player.money = roundMoney(player.money + finalSalary);
    }
    
    saveGame();
    return res.json({ ok: true, day: player.day, ap: player.ap, money: player.money, msg });
  }

  // ===== 3. 正常状态（上班/休息） =====
  const dayOfMonth = player.day % 28 === 0 ? 28 : player.day % 28;
  const dayOfWeek = player.day % 7 === 0 ? 7 : player.day % 7;
  let isRestDay = (dayOfMonth >= 22 && dayOfMonth <= 28) ? (dayOfWeek >= 4) : (dayOfWeek === 6 || dayOfWeek === 7);

  // 病根积累（336天后新手保护结束）
  if (!isRestDay && player.day > 336) {
    let sickAdd = player.job === 'mental' ? 1 : 3;
    player.sickPoints += sickAdd;
    
    // 触发强制送医
    if (player.sickPoints >= 1000) {
      player.hospitalizedDays = 10;
      player.sickLeaveHeavy = true; // 👈 标记为重症
      player.sickPoints = 0;
      player.money -= 8000;
      if (player.money < 0) {
        return res.json({ ok: false, isGameOver: true, msg: `💀 积劳成疾被强制送医，因交不起 8000 元医疗费倒在了病床上...` });
      }
      msg += ` 🚑 警告：你因积劳成疾被强制送医 10 天，扣除医疗费 8000 元！`;
      saveGame();
      return res.json({ ok: true, day: player.day, ap: 0, money: player.money, msg });
    }
  }

  // 正常发工资
  if (player.day % 28 === 0) {
    const salary = player.job === 'mental' ? MENTAL_SALARY : PHYSICAL_SALARY;
    player.money = roundMoney(player.money + salary);
    msg += ` 💰 发工资啦！获得 ${salary} 元。`;
  }

  // 体力恢复 & 工作疲劳（原逻辑保持不变）
  let maxAp = (player.job === 'mental') ? (isRestDay ? 100 : 20) : (isRestDay ? 60 : 10);
  if (player.inventory && player.inventory.earplugs) maxAp += 5;
  player.ap = maxAp;

  if (!isRestDay && player.job === 'physical') {
    player.stats.pullup += 0.2;
    player.stats.run += 0.2;
    const fAdd = (player.inventory && player.inventory.exoskeleton) ? 10 : 15;
    player.fatigue.pullup += fAdd;
    player.fatigue.run += fAdd;
  }

  // 疲劳恢复 & 衰退判定（原逻辑保持不变）
  for (const stat in player.fatigue) {
    if (player.lastTrainDay[stat] !== player.day) player.fatigue[stat] = Math.max(0, player.fatigue[stat] - 15);
  }
  for (const stat in player.stats) {
    if (player.day - player.lastTrainDay[stat] > 14) player.stats[stat] = Math.max(0, player.stats[stat] * 0.98);
  }

  saveGame();
  res.json({ ok: true, day: player.day, isRestDay, ap: player.ap, money: player.money, msg: msg.trim() });
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

// ===== 购买商品 =====
app.post('/api/buy-item', (req, res) => {
  const { itemKey } = req.body;
  const item = SHOP_ITEMS[itemKey];
  if (!item) return res.json({ ok: false, msg: '没有这个商品' });

  // 永久道具不能重复购买
  if (itemKey !== 'energyDrink' && player.inventory[itemKey]) {
    return res.json({ ok: false, msg: '你已拥有该道具' });
  }

  if (player.money < item.price) {
    return res.json({ ok: false, msg: '现金不足！' });
  }

  player.money -= item.price;
  
  if (itemKey === 'energyDrink') {
    player.inventory.energyDrink += 1;
    // 直接清空所有疲劳
    for (let k in player.fatigue) player.fatigue[k] = 0;
  } else {
    player.inventory[itemKey] = true;
  }

  saveGame();
  res.json({ ok: true, msg: `成功购买：${item.name}`, money: player.money });
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

app.post('/api/hospital', (req, res) => {
  if (player.sickPoints <= 0) return res.json({ ok: false, msg: '身体很健康，不需要去医院。' });
  const medicalFee = Math.floor(player.sickPoints * 3);
  if (player.money < medicalFee) return res.json({ ok: false, msg: `连 ${medicalFee} 元的门诊费都交不起。` });

  player.money -= medicalFee;
  player.sickPoints = 0;
  
  // 👈 主动就医：1天，轻症
  player.hospitalizedDays = 1;
  player.sickLeaveLight = true; 
  
  saveGame();
  res.json({ ok: true, msg: `🏥 主动就医成功！花费 ${medicalFee} 元，请了 1 天病假（扣10%工资）。` });
});

app.listen(3000, () => {
  console.log('🏃 赛博社畜体测模拟器后端已启动：http://localhost:3000');
});