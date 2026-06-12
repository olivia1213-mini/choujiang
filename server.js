const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3456;

// ========== CORS & 中间件 ==========
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'data.json');
console.log('[store] data.json 路径:', DATA_FILE, '(cwd:', process.cwd(), ')');

// ========== 数据持久化 ==========
let store = { setup: null, prizes: [], participants: [], results: [] };
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    if (loaded.setup !== undefined) store.setup = loaded.setup;
    if (loaded.prizes) store.prizes = loaded.prizes;
    if (loaded.participants) store.participants = loaded.participants;
    if (loaded.results) store.results = loaded.results;
    console.log('[store] 已从 data.json 加载数据，参与者:', store.participants.length, '人');
  }
} catch (e) { console.log('[store] 无已有数据或读取失败'); }

function persistStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
    console.log('[store] 已保存到', DATA_FILE);
  } catch(e) { console.error('[store] 保存失败:', e.message); }
}

// ========== SSE 客户端管理（实时推送） ==========
const sseClients = [];

// SSE 心跳（每15秒发一次，防止连接断开）
setInterval(() => {
  sseClients.forEach(res => {
    try { res.write('id: ' + Date.now() + '\n\n'); } catch(e) {}
  });
}, 15000);

function broadcastSSE(event, data) {
  const payload = JSON.stringify(data);
  const msg =
    'event: ' + event + '\n' +
    'data: ' + payload + '\n\n';
  sseClients.forEach(res => {
    try { res.write(msg); } catch(e) {
      // 写入失败的客户端在 close 事件中清理
    }
  });
}

// ========== API 路由 ==========

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), clients: sseClients.length, participants: store.participants.length });
});

// 调试：手动触发持久化
app.post('/api/_persist', (req, res) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
    res.json({ ok: true, path: DATA_FILE, size: fs.statSync(DATA_FILE).size });
  } catch(e) {
    res.status(500).json({ error: e.message, path: DATA_FILE });
  }
});

// 动态更新隧道地址（无需重启服务器）
let _dynamicPublicUrl = null;
app.post('/api/setpublicurl', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url 参数必填' });
  _dynamicPublicUrl = url.replace(/\/$/, ''); // 去掉末尾斜杠
  process.env.PUBLIC_URL = _dynamicPublicUrl;
  console.log('[setpublicurl] 已更新 PUBLIC_URL =', _dynamicPublicUrl);
  res.json({ ok: true, url: _dynamicPublicUrl });
});

// 返回手机可访问的 base URL（优先动态设置 > PUBLIC_URL 环境变量 > 局域网 IP）
app.get('/api/baseurl', (req, res) => {
  const publicUrl = _dynamicPublicUrl || process.env.PUBLIC_URL;
  if (publicUrl) {
    return res.json({ base: publicUrl, all: [publicUrl], source: 'env' });
  }
  const host = req.get('host');
  const port = process.env.PORT || 3456;
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        // 跳过虚拟适配器
        if (name.includes('Virtual') || name.includes('vEthernet') || name.includes('VMware') || name.includes('Bluetooth') || name.includes('Loopback')) continue;
        ips.push(net.address);
      }
    }
  }
  // 优先返回常见内网段 (10.x > 172.16-31.x > 192.168.x)
  ips.sort(function(a, b) {
    var scoreA = a.startsWith('10.') ? 3 : a.startsWith('172.') ? 2 : 1;
    var scoreB = b.startsWith('10.') ? 3 : b.startsWith('172.') ? 2 : 1;
    return scoreB - scoreA;
  });
  const chosen = ips[0] || host;
  const base = req.protocol + '://' + chosen + ':' + port;
  res.json({ base: base, all: ips });
});

// 获取全部数据
app.get('/api/data', (req, res) => {
  res.json(store);
});

// 替换全部数据（管理员初始化/导入/同步）
app.post('/api/data', (req, res) => {
  const body = req.body;
  if (body.setup !== undefined) store.setup = body.setup;
  if (body.prizes !== undefined) store.prizes = body.prizes || [];
  if (body.participants !== undefined) store.participants = body.participants || [];
  if (body.results !== undefined) store.results = body.results || [];
  broadcastSSE('data', store);
  persistStore();
  res.json({ ok: true });
});

// 获取设置
app.get('/api/setup', (req, res) => {
  res.json(store.setup || null);
});

// 更新设置（活动管理员保存）
app.post('/api/setup', (req, res) => {
  store.setup = req.body;
  broadcastSSE('setup', store.setup);
  persistStore();
  res.json({ ok: true });
});

// 获取奖项
app.get('/api/prizes', (req, res) => {
  res.json(store.prizes || []);
});

// 更新奖项
app.post('/api/prizes', (req, res) => {
  store.prizes = req.body || [];
  broadcastSSE('prizes', store.prizes);
  persistStore();
  res.json({ ok: true });
});

// 获取参与者列表
app.get('/api/participants', (req, res) => {
  res.json(store.participants || []);
});

// 添加参与者（手机签到）
app.post('/api/participants', (req, res) => {
  const { name, phone, actId, source } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: '姓名和手机号为必填' });
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }
  // 按 actId 去重（同一活动内同一手机号只允许一次）
  const dup = actId
    ? store.participants.some(p => p.phone === phone && p.actId === actId)
    : store.participants.some(p => p.phone === phone);
  if (dup) {
    return res.status(409).json({ error: '该手机号已参与本次活动' });
  }
  const entry = {
    name,
    phone,
    actId: actId || '',
    joinTime: new Date().toLocaleString('zh-CN'),
    source: source || 'qr'
  };
  store.participants.push(entry);
  broadcastSSE('participants', store.participants);
  persistStore();
  res.json({ ok: true, count: store.participants.length, entry });
});

// 批量设置参与者（管理员导入/同步）
app.put('/api/participants', (req, res) => {
  store.participants = req.body || [];
  broadcastSSE('participants', store.participants);
  persistStore();
  res.json({ ok: true, count: store.participants.length });
});

// 删除参与者
app.delete('/api/participants/:phone', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  store.participants = store.participants.filter(p => p.phone !== phone);
  broadcastSSE('participants', store.participants);
  persistStore();
  res.json({ ok: true, count: store.participants.length });
});

// 获取抽奖结果
app.get('/api/results', (req, res) => {
  res.json(store.results || []);
});

// 添加抽奖结果
app.post('/api/results', (req, res) => {
  store.results.push(req.body);
  broadcastSSE('results', store.results);
  persistStore();
  res.json({ ok: true });
});

// 撤销最近一次抽奖
app.delete('/api/results/last', (req, res) => {
  store.results.pop();
  broadcastSSE('results', store.results);
  persistStore();
  res.json({ ok: true });
});

// 清空全部数据（重置活动）
app.post('/api/reset', (req, res) => {
  store = { setup: null, prizes: [], participants: [], results: [] };
  broadcastSSE('reset', {});
  broadcastSSE('data', store);
  persistStore();
  res.json({ ok: true });
});

// ========== SSE 实时推送端点 ==========
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
  res.write('event: connected\ndata: {}\n\n');

  sseClients.push(res);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// ========== 启动服务器 ==========
app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  console.log('\n==========================================');
  console.log('  🎉 扫码抽奖系统 v2.0 - 服务已启动！');
  console.log('==========================================');
  console.log('  端口: ' + PORT);
  console.log('  本机访问:');
  console.log('    http://localhost:' + PORT + '/admin.html');
  console.log('    http://localhost:' + PORT + '/join.html');
  console.log('    http://localhost:' + PORT + '/lottery.html');
  console.log('  局域网地址 (手机扫码用):');
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('    http://' + net.address + ':' + PORT + '/admin.html');
      }
    }
  }
  console.log('  SSE 实时推送: /api/stream');
  console.log('  数据接口: /api/data');
  console.log('==========================================\n');
});
