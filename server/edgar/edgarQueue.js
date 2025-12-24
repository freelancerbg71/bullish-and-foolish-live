import { processFilingForTicker } from "./filingWorkflow.js";

const MAX_PARALLEL_JOBS = Number(process.env.EDGAR_MAX_PARALLEL_JOBS) || 2;
const BETWEEN_JOBS_DELAY_MS = Number(process.env.EDGAR_JOB_DELAY_MS) || 400;
const MAX_QUEUE_LENGTH = Number(process.env.EDGAR_MAX_QUEUE) || 100;
const TICKER_NOT_FOUND_COOLDOWN_MS = Number(process.env.EDGAR_TICKER_NOT_FOUND_COOLDOWN_MS) || 24 * 60 * 60 * 1000; // 24h

const queue = [];
const jobState = new Map();
const notFoundUntil = new Map(); // ticker -> ts
const notFoundLogOnce = new Map(); // ticker -> lastLogTs
let activeJobs = 0;
let processing = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTicker(ticker) {
  return ticker ? String(ticker).toUpperCase().trim() : "";
}

function isTickerNotFoundError(err) {
  const code = err?.code;
  if (code === "EDGAR_TICKER_NOT_FOUND") return true;
  const msg = String(err?.message || "");
  return msg.includes("CIK not found for ticker");
}

function shouldSuppressNotFound(ticker) {
  const until = notFoundUntil.get(ticker) || 0;
  return Number.isFinite(until) && Date.now() < until;
}

function noteNotFound(ticker, err) {
  const until = Date.now() + TICKER_NOT_FOUND_COOLDOWN_MS;
  notFoundUntil.set(ticker, until);

  const last = notFoundLogOnce.get(ticker) || 0;
  const now = Date.now();
  // Log at most once every cooldown window per ticker.
  if (now - last < TICKER_NOT_FOUND_COOLDOWN_MS) return;
  notFoundLogOnce.set(ticker, now);
  console.warn("[edgarQueue] ticker not found; suppressing further jobs temporarily", {
    ticker,
    until: new Date(until).toISOString(),
    error: err?.message || "CIK not found for ticker"
  });
}

function snapshot(job) {
  if (!job) return null;
  const { ticker, status, enqueuedAt, startedAt, finishedAt, error, lastCount } = job;
  return { ticker, status, enqueuedAt, startedAt, finishedAt, error, message: error, lastCount };
}

async function runJob(job) {
  job.startedAt = new Date().toISOString();
  job.status = "running";
  try {
    const result = await processFilingForTicker(job.ticker, null, { createEvent: true, includeFilingSignals: true, includeLatestFilingMeta: true });
    job.status = "done";
    job.lastCount = Array.isArray(result?.fundamentals) ? result.fundamentals.length : 0;
  } catch (err) {
    if (isTickerNotFoundError(err)) {
      job.status = "not_found";
      job.error = err?.message || "CIK not found for ticker";
      noteNotFound(job.ticker, err);
    } else {
      job.status = "failed";
      job.error = err?.message || "EDGAR fetch failed";
      console.error("[edgarQueue] job failed", job.ticker, job.error, err?.stack || err);
    }
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length && activeJobs < MAX_PARALLEL_JOBS) {
    const job = queue.shift();
    activeJobs++;
    // Do not await here; we want to respect max concurrency while keeping the loop simple.
    runJob(job)
      .catch(() => {
        // Errors are captured inside runJob
      })
      .finally(async () => {
        activeJobs = Math.max(0, activeJobs - 1);
        await sleep(BETWEEN_JOBS_DELAY_MS);
        processing = false;
        processQueue();
      });
  }
  processing = false;
}

export function enqueueFundamentalsJob(ticker) {
  const key = normalizeTicker(ticker);
  if (!key) throw new Error("ticker is required for EDGAR job");
  if (shouldSuppressNotFound(key)) {
    const until = notFoundUntil.get(key);
    return {
      ticker: key,
      status: "not_found",
      message: `Ticker not found in SEC directory (retry after ${new Date(until).toISOString()}).`
    };
  }
  const existing = jobState.get(key);
  if (existing && (existing.status === "queued" || existing.status === "running")) {
    return snapshot(existing);
  }
  if (queue.length >= MAX_QUEUE_LENGTH) {
    return { ticker: key, status: "busy", message: "EDGAR queue is full, try again soon." };
  }
  // If somehow a duplicate exists in the pending queue, surface that instead of enqueueing again.
  const queued = queue.find((job) => job.ticker === key);
  if (queued) return snapshot(queued);

  const job = {
    ticker: key,
    status: "queued",
    enqueuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    lastCount: null
  };
  jobState.set(key, job);
  queue.push(job);
  processQueue();
  return snapshot(job);
}

export function getJobState(ticker) {
  const key = normalizeTicker(ticker);
  return snapshot(jobState.get(key));
}

export function getQueueDepth() {
  return {
    pending: queue.length,
    active: activeJobs,
    max: MAX_QUEUE_LENGTH
  };
}
