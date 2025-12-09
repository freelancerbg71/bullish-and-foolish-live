import { processFilingForTicker } from "./filingWorkflow.js";

const MAX_PARALLEL_JOBS = Number(process.env.EDGAR_MAX_PARALLEL_JOBS) || 2;
const BETWEEN_JOBS_DELAY_MS = Number(process.env.EDGAR_JOB_DELAY_MS) || 400;
const MAX_QUEUE_LENGTH = Number(process.env.EDGAR_MAX_QUEUE) || 100;

const queue = [];
const jobState = new Map();
let activeJobs = 0;
let processing = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTicker(ticker) {
  return ticker ? String(ticker).toUpperCase().trim() : "";
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
    const result = await processFilingForTicker(job.ticker, null, { createEvent: true });
    job.status = "done";
    job.lastCount = Array.isArray(result?.fundamentals) ? result.fundamentals.length : 0;
  } catch (err) {
    job.status = "failed";
    job.error = err?.message || "EDGAR fetch failed";
    console.error("[edgarQueue] job failed", job.ticker, job.error, err?.stack || err);
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
