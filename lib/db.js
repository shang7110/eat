/**
 * 简易文档数据库（替代微信云数据库）
 * ─────────────────────────────────────────────
 * 数据结构：{ "集合名": { "_id": {文档} } }
 * 落盘：DATA_DIR/data.json（写操作后延迟合并写入，避免频繁 IO）
 *
 * 支持的能力（仅覆盖本项目实际用到的子集）：
 *   db.collection(name).add({data})
 *   db.collection(name).doc(id).get() / set({data}) / update({data}) / remove()
 *   db.collection(name).where(cond).limit(n).orderBy(f, 'desc').get()
 *   db.collection(name).where(cond).count()
 *   db.command.inc(n) / gt / gte / lt / lte / neq / in
 *
 * ⚠️ 多实例部署时需换成外部数据库（MongoDB / Redis），见 README 的「数据层替换」。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const WRITE_DELAY = 800;

let store = null;
let writeTimer = null;
let dirty = false;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (store) return store;
  ensureDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
    } else {
      store = {};
    }
  } catch (e) {
    console.error('[db] 数据文件损坏，已重置:', e.message);
    store = {};
  }
  return store;
}

function scheduleSave() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      ensureDir();
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, null, 0), 'utf8');
      fs.renameSync(tmp, DATA_FILE);   // 原子替换，避免写一半损坏
    } catch (e) {
      console.error('[db] 落盘失败:', e.message);
    }
  }, WRITE_DELAY);
}

/** 进程退出前强制落盘 */
function flush() {
  if (!store) return;
  try {
    ensureDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 0), 'utf8');
    console.log('[db] 已落盘:', DATA_FILE);
  } catch (e) {
    console.error('[db] flush 失败:', e.message);
  }
}

/* ---------------- 条件匹配 ---------------- */

const OP = '__op';

function matchValue(docVal, cond) {
  if (cond && typeof cond === 'object' && cond[OP]) {
    const v = cond.value;
    switch (cond[OP]) {
      case 'gt': return docVal > v;
      case 'gte': return docVal >= v;
      case 'lt': return docVal < v;
      case 'lte': return docVal <= v;
      case 'neq': return docVal !== v;
      case 'in': return Array.isArray(v) && v.includes(docVal);
      case 'nin': return Array.isArray(v) && !v.includes(docVal);
      case 'exists': return v ? docVal !== undefined : docVal === undefined;
      default: return false;
    }
  }
  // 数组包含判断（云数据库语义：字段为数组时，值是成员即匹配）
  if (Array.isArray(docVal) && !Array.isArray(cond)) return docVal.includes(cond);
  return docVal === cond;
}

function matches(doc, cond) {
  if (!cond || typeof cond !== 'object') return true;
  // 支持 db.command.and/or
  if (cond[OP] === 'and') return cond.value.every((c) => matches(doc, c));
  if (cond[OP] === 'or') return cond.value.some((c) => matches(doc, c));
  return Object.keys(cond).every((k) => matchValue(doc[k], cond[k]));
}

/* ---------------- 更新操作 ---------------- */

function applyUpdate(doc, data) {
  Object.keys(data).forEach((k) => {
    const v = data[k];
    if (v && typeof v === 'object' && v[OP]) {
      if (v[OP] === 'inc') doc[k] = (Number(doc[k]) || 0) + Number(v.value);
      else if (v[OP] === 'set') doc[k] = v.value;
      else if (v[OP] === 'remove') delete doc[k];
      else doc[k] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      // 对象字段做浅合并（云数据库 update 的语义）
      doc[k] = Object.assign({}, doc[k] || {}, v);
    } else {
      doc[k] = v;
    }
  });
  return doc;
}

/* ---------------- API ---------------- */

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

class Query {
  constructor(coll, cond) {
    this._coll = coll;
    this._cond = cond || {};
    this._limit = 0;
    this._order = null;
  }

  limit(n) {
    this._limit = Number(n) || 0;
    return this;
  }

  orderBy(field, dir) {
    this._order = { field, dir: dir === 'desc' ? -1 : 1 };
    return this;
  }

  _rows() {
    const s = load();
    const bucket = s[this._coll] || {};
    let rows = Object.keys(bucket)
      .map((id) => Object.assign({ _id: id }, bucket[id]))
      .filter((d) => matches(d, this._cond));
    if (this._order) {
      const { field, dir } = this._order;
      rows.sort((a, b) => (a[field] > b[field] ? dir : a[field] < b[field] ? -dir : 0));
    }
    if (this._limit > 0) rows = rows.slice(0, this._limit);
    return rows;
  }

  async get() {
    return { data: this._rows() };
  }

  async count() {
    return { total: this._rows().length };
  }

  async update(args) {
    const rows = this._rows();
    const s = load();
    s[this._coll] = s[this._coll] || {};
    rows.forEach((r) => {
      s[this._coll][r._id] = applyUpdate(s[this._coll][r._id] || {}, (args && args.data) || {});
    });
    scheduleSave();
    return { stats: { updated: rows.length } };
  }

  async remove() {
    const rows = this._rows();
    const s = load();
    rows.forEach((r) => { delete s[this._coll][r._id]; });
    scheduleSave();
    return { stats: { removed: rows.length } };
  }
}

class DocRef {
  constructor(coll, id) {
    this._coll = coll;
    this._id = String(id);
  }

  async get() {
    const s = load();
    const doc = (s[this._coll] || {})[this._id];
    // 与云数据库行为对齐：不存在时返回 data: null（调用方通常用 try/catch 或判空处理）
    return { data: doc ? Object.assign({ _id: this._id }, doc) : null };
  }

  async set(args) {
    const s = load();
    s[this._coll] = s[this._coll] || {};
    s[this._coll][this._id] = Object.assign({}, (args && args.data) || {});
    scheduleSave();
    return { _id: this._id, stats: { updated: 1 } };
  }

  async update(args) {
    const s = load();
    s[this._coll] = s[this._coll] || {};
    const cur = s[this._coll][this._id];
    if (!cur) {
      // 与云数据库一致：更新不存在的文档报错
      const err = new Error('document.update:fail document with _id ' + this._id + ' does not exist');
      err.errCode = -1;
      throw err;
    }
    s[this._coll][this._id] = applyUpdate(cur, (args && args.data) || {});
    scheduleSave();
    return { stats: { updated: 1 } };
  }

  async remove() {
    const s = load();
    if (s[this._coll]) delete s[this._coll][this._id];
    scheduleSave();
    return { stats: { removed: 1 } };
  }
}

class Collection {
  constructor(name) {
    this._name = name;
  }

  doc(id) {
    return new DocRef(this._name, id);
  }

  where(cond) {
    return new Query(this._name, cond);
  }

  limit(n) {
    return new Query(this._name, {}).limit(n);
  }

  orderBy(f, d) {
    return new Query(this._name, {}).orderBy(f, d);
  }

  async add(args) {
    const s = load();
    s[this._name] = s[this._name] || {};
    const data = Object.assign({}, (args && args.data) || {});
    const id = data._id || genId();
    delete data._id;
    s[this._name][id] = data;
    scheduleSave();
    return { _id: id };
  }

  async get() {
    return new Query(this._name, {}).get();
  }
}

function command() {
  return {
    inc: (n) => ({ [OP]: 'inc', value: Number(n) || 0 }),
    set: (v) => ({ [OP]: 'set', value: v }),
    remove: () => ({ [OP]: 'remove' }),
    gt: (v) => ({ [OP]: 'gt', value: v }),
    gte: (v) => ({ [OP]: 'gte', value: v }),
    lt: (v) => ({ [OP]: 'lt', value: v }),
    lte: (v) => ({ [OP]: 'lte', value: v }),
    neq: (v) => ({ [OP]: 'neq', value: v }),
    in: (v) => ({ [OP]: 'in', value: v }),
    nin: (v) => ({ [OP]: 'nin', value: v }),
    exists: (v) => ({ [OP]: 'exists', value: v }),
    and: (...args) => {
      const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      return { [OP]: 'and', value: list };
    },
    or: (...args) => {
      const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      return { [OP]: 'or', value: list };
    }
  };
}

const cmd = command();

const db = {
  collection: (name) => new Collection(name),
  command: cmd,
  // 项目里用到的 createCollection（本实现无需建表，直接返回成功）
  createCollection: async (name) => {
    const s = load();
    if (!s[name]) s[name] = {};
    scheduleSave();
    return { errMsg: 'createCollection:ok' };
  }
};

module.exports = { db, cmd, flush, DATA_DIR };
