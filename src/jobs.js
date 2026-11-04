'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('./config');
const { runView } = require('./viewer');

const RESULTS_DIR = path.join(app.dataDir, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const MAX_EVENTS = 200;

class Job {
  constructor(options) {
    this.id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.finishedAt = null;
    this.status = 'queued'; // queued | running | done | error | cancelled
    this.phase = 'queued';
    this.message = 'Waiting for a free browser slot…';
    this.options = options;
    this.events = [];
    this.result = null;
    this.error = null;
    this.exitIp = null;
    this.previewUrl = null;
    this.attempt = 0;
    this.maxAttempts = 0;
    this.cancelled = false;
    this.dir = path.join(RESULTS_DIR, this.id);
    this._listeners = new Set();
    this._cancelHooks = new Set();
  }

  emit(type, data = {}) {
    const event = { type, t: Date.now(), ...data };
    if (type === 'phase') {
      this.phase = data.phase;
      this.message = data.message;
    } else if (type === 'ip') {
      this.exitIp = data;
    } else if (type === 'preview') {
      this.previewUrl = data.url;
    } else if (type === 'attempt') {
      this.attempt = data.attempt;
      this.maxAttempts = data.maxAttempts;
    }
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const fn of this._listeners) {
      try {
        fn(event);
      } catch {
        /* listener errors never break the job */
      }
    }
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  onCancel(fn) {
    this._cancelHooks.add(fn);
  }

  cancel() {
    if (this.status !== 'queued' && this.status !== 'running') return false;
    this.cancelled = true;
    for (const fn of this._cancelHooks) fn();
    if (this.status === 'queued') finish(this, 'cancelled');
    return true;
  }

  throwIfCancelled() {
    if (this.cancelled) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
  }

  summary() {
    const r = this.result;
    return {
      id: this.id,
      url: this.options.url,
      country: this.options.country || '',
      device: this.options.device,
      ipMode: this.options.ipMode,
      status: this.status,
      phase: this.phase,
      message: this.message,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      attempt: this.attempt,
      maxAttempts: this.maxAttempts,
      exitIp: (r && r.exitIp) || this.exitIp,
      previewUrl: this.previewUrl,
      httpStatus: r ? r.status : null,
      title: r ? r.title : '',
      finalUrl: r ? r.finalUrl : '',
      blocked: r ? r.blocked : null,
      bytes: r ? r.bytes : null,
      totalMs: r ? r.timings.totalMs : null,
      hasScreenshot: Boolean(r),
      error: this.error,
    };
  }

  toJSON() {
    return { ...this.summary(), options: this.options, result: this.result, events: this.events };
  }
}

// ---------------------------------------------------------------------------
// Store + queue
// ---------------------------------------------------------------------------
const jobs = new Map(); // insertion-ordered: oldest first
const queue = [];
let running = 0;

function persist(job) {
  try {
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(job.toJSON()));
  } catch (err) {
    console.error('Could not persist job', job.id, err.message);
  }
}

function prune() {
  while (jobs.size > app.maxHistory) {
    const [oldestId, oldest] = jobs.entries().next().value;
    if (oldest.status === 'running' || oldest.status === 'queued') break;
    jobs.delete(oldestId);
    fs.rm(oldest.dir, { recursive: true, force: true }, () => {});
  }
}

function finish(job, status) {
  job.status = status;
  job.finishedAt = new Date().toISOString();
  job.emit('end', { status });
  persist(job);
  job._listeners.clear();
  job._cancelHooks.clear();
}

function pump() {
  while (running < app.maxConcurrent && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    running++;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    runView(job)
      .then((result) => {
        job.result = { ...result, attemptDir: `a${result.attempts}` };
        job.emit('phase', { phase: 'done', message: result.blocked ? `Loaded, but looks blocked: ${result.blocked.reason}` : 'Done' });
        finish(job, 'done');
      })
      .catch((err) => {
        if (err.code === 'CANCELLED' || job.cancelled) {
          job.emit('phase', { phase: 'cancelled', message: 'Cancelled' });
          finish(job, 'cancelled');
          return;
        }
        const info = err.info || { code: 'UNKNOWN', message: err.message };
        job.error = { code: info.code, message: info.message, hint: info.hint || '', raw: info.raw || '' };
        job.emit('phase', { phase: 'error', message: info.message });
        finish(job, 'error');
      })
      .finally(() => {
        running--;
        prune();
        pump();
      });
  }
  // Tell queued jobs where they stand.
  queue.forEach((job, i) => {
    if (job.status === 'queued') job.emit('phase', { phase: 'queued', message: i === 0 ? 'Queued — next in line' : `Queued — ${i} ahead of this one` });
  });
}

function createJob(options) {
  const job = new Job(options);
  jobs.set(job.id, job);
  queue.push(job);
  job.emit('phase', { phase: 'queued', message: 'Queued' });
  pump();
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function listJobs(limit = 50) {
  return Array.from(jobs.values())
    .reverse()
    .slice(0, limit)
    .map((j) => j.summary());
}

function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancel();
  jobs.delete(id);
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
  return true;
}

function clearHistory() {
  for (const job of Array.from(jobs.values())) {
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') deleteJob(job.id);
  }
}

// Restore history from disk.
function restore() {
  let entries = [];
  for (const id of fs.readdirSync(RESULTS_DIR)) {
    const file = path.join(RESULTS_DIR, id, 'job.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      entries.push(data);
    } catch {
      fs.rm(path.join(RESULTS_DIR, id), { recursive: true, force: true }, () => {});
    }
  }
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  entries = entries.slice(-app.maxHistory);
  for (const data of entries) {
    const job = new Job(data.options);
    Object.assign(job, {
      id: data.id,
      createdAt: data.createdAt,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      status: data.status === 'running' || data.status === 'queued' ? 'error' : data.status,
      phase: data.phase,
      message: data.message,
      result: data.result,
      error: data.error,
      exitIp: data.exitIp,
      previewUrl: data.previewUrl,
      attempt: data.attempt,
      maxAttempts: data.maxAttempts,
      events: data.events || [],
    });
    job.dir = path.join(RESULTS_DIR, job.id);
    jobs.set(job.id, job);
  }
}
restore();

module.exports = { createJob, getJob, listJobs, deleteJob, clearHistory, RESULTS_DIR };
