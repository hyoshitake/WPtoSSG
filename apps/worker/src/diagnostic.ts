import type { DiagnosticEvidence, DiagnosticResult, JobEvent, RiskLevel } from '@wptossg/shared';
import { createJobEvent } from '@wptossg/shared';
import { load } from 'cheerio';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One rendered page's HTML to analyse. */
export interface DiagnosticPage {
  url: string;
  html: string;
}

export interface DiagnosticOptions {
  /** Site origin used to distinguish same-domain vs cross-domain requests. */
  siteUrl: string;
  /** Pages collected during RENDER_AND_SNAPSHOT / ASSET_FETCH_AND_REWRITE. */
  pages: DiagnosticPage[];
}

export interface DiagnosticRunResult {
  diagnostic: DiagnosticResult;
  events: JobEvent[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a login-wall, authentication barrier, or admin area.
 * Matched against full URLs (pathname + search) and visible text content.
 */
const LOGIN_URL_PATTERNS: RegExp[] = [
  /wp-login\.php/i,
  /\/login\b/i,
  /\/sign-?in\b/i,
  /\/auth\b/i,
  /\/account\b/i,
  /\/admin\b/i,
  /\/dashboard\b/i,
  /[?&](redirect_to|next|return_url)=/i,
];

/**
 * Patterns that indicate an API call within the same site.
 * Matched against script `src` attributes and inline script text.
 */
const API_URL_PATTERNS: RegExp[] = [
  /\/wp-json\b/i,
  /\/api\b/i,
  /\/graphql\b/i,
  /\.json\b/i,
  /\/rest\b/i,
];

/**
 * Text/attribute patterns that indicate the page performs XHR / fetch calls.
 */
const XHR_INLINE_PATTERNS: RegExp[] = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /\$\.ajax\b/,
  /axios\s*\.\s*(get|post|put|delete|patch|request)\s*\(/i,
  /\bwp\.apiFetch\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDiagnosticEvent(
  jobId: string,
  type: JobEvent['type'],
  message: string,
  details?: Record<string, unknown>,
): JobEvent {
  return createJobEvent({
    jobId,
    stage: 'DIAGNOSTIC',
    type,
    message,
    details,
  });
}

function isSameDomain(href: string, siteUrl: string): boolean {
  try {
    const base = new URL(siteUrl);
    const target = new URL(href, siteUrl);
    return target.hostname === base.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-page signal extraction
// ---------------------------------------------------------------------------

interface PageSignals {
  apiUrls: string[];
  hasXhrCall: boolean;
  forms: Array<{ selector: string; action?: string }>;
  loginHints: string[];
  passwordInputs: number;
}

function extractPageSignals(url: string, html: string, siteUrl: string): PageSignals {
  const $ = load(html);

  // --- API URLs via <script src> pointing at same-domain JSON/REST endpoints ---
  const apiUrls: string[] = [];
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (!src) return;
    if (!isSameDomain(src, siteUrl)) return;
    if (API_URL_PATTERNS.some((p) => p.test(src))) {
      try {
        apiUrls.push(new URL(src, url).toString());
      } catch {
        apiUrls.push(src);
      }
    }
  });

  // --- XHR / fetch calls inside inline scripts ---
  let hasXhrCall = false;
  $('script:not([src])').each((_, el) => {
    const text = $(el).html() ?? '';
    if (XHR_INLINE_PATTERNS.some((p) => p.test(text))) {
      hasXhrCall = true;
    }
  });

  // --- Form elements ---
  const forms: Array<{ selector: string; action?: string }> = [];
  $('form').each((i, el) => {
    const action = $(el).attr('action');
    forms.push({ selector: `form:nth-of-type(${i + 1})`, action });
  });

  // --- Login hints ---
  const loginHints: string[] = [];
  // Check current page URL
  if (LOGIN_URL_PATTERNS.some((p) => p.test(url))) {
    loginHints.push(url);
  }
  // Check form actions
  for (const form of forms) {
    if (form.action && LOGIN_URL_PATTERNS.some((p) => p.test(form.action!))) {
      loginHints.push(form.action);
    }
  }
  // Check <a href> links pointing at login-like URLs
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (LOGIN_URL_PATTERNS.some((p) => p.test(href))) {
      try {
        loginHints.push(new URL(href, url).toString());
      } catch {
        loginHints.push(href);
      }
    }
  });

  // --- Password inputs ---
  const passwordInputs = $('input[type="password"]').length;

  return { apiUrls, hasXhrCall, forms, loginHints, passwordInputs };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregateSignals(
  allSignals: Array<{ url: string; signals: PageSignals }>,
): { evidence: DiagnosticEvidence[]; reasons: string[]; riskLevel: RiskLevel } {
  const evidence: DiagnosticEvidence[] = [];
  const reasonSet = new Set<string>();

  const seenApiUrls = new Set<string>();
  const seenLoginHints = new Set<string>();

  let totalForms = 0;
  let pagesWithXhr = 0;
  let pagesWithLoginHint = 0;
  let pagesWithPasswordInput = 0;

  for (const { url: pageUrl, signals } of allSignals) {
    // API / XHR
    for (const apiUrl of signals.apiUrls) {
      if (!seenApiUrls.has(apiUrl)) {
        seenApiUrls.add(apiUrl);
        evidence.push({
          type: 'api',
          location: apiUrl,
          details: { discoveredOn: pageUrl },
        });
      }
    }
    if (signals.hasXhrCall) {
      pagesWithXhr += 1;
      evidence.push({
        type: 'pattern',
        location: pageUrl,
        details: { pattern: 'inline fetch/XHR call detected' },
      });
    }

    // Forms
    for (const form of signals.forms) {
      totalForms += 1;
      evidence.push({
        type: 'selector',
        location: pageUrl,
        details: { selector: form.selector, action: form.action ?? '(no action)' },
      });
    }

    // Login hints
    if (signals.loginHints.length > 0) {
      pagesWithLoginHint += 1;
    }
    for (const hint of signals.loginHints) {
      if (!seenLoginHints.has(hint)) {
        seenLoginHints.add(hint);
        evidence.push({
          type: 'url',
          location: hint,
          details: { discoveredOn: pageUrl, reason: 'matches login/auth URL pattern' },
        });
      }
    }

    // Password inputs
    if (signals.passwordInputs > 0) {
      pagesWithPasswordInput += 1;
      evidence.push({
        type: 'selector',
        location: pageUrl,
        details: { selector: 'input[type="password"]', count: signals.passwordInputs },
      });
    }
  }

  // --- Build reasons ---
  if (seenApiUrls.size > 0) {
    reasonSet.add(`${seenApiUrls.size} same-domain API endpoint(s) detected via <script src>`);
  }
  if (pagesWithXhr > 0) {
    reasonSet.add(`Inline fetch/XHR calls found on ${pagesWithXhr} page(s)`);
  }
  if (totalForms > 0) {
    reasonSet.add(`${totalForms} <form> element(s) found across the site`);
  }
  if (pagesWithLoginHint > 0) {
    reasonSet.add(`Login/authentication URL patterns detected on ${pagesWithLoginHint} page(s)`);
  }
  if (pagesWithPasswordInput > 0) {
    reasonSet.add(`Password input field(s) found on ${pagesWithPasswordInput} page(s)`);
  }

  // --- Compute risk level ---
  //
  // high:   login/auth indicators (password inputs OR login URL patterns)
  // medium: API calls OR forms
  // low:    no signals
  let riskLevel: RiskLevel = 'low';

  if (pagesWithPasswordInput > 0 || pagesWithLoginHint > 0) {
    riskLevel = 'high';
  } else if (seenApiUrls.size > 0 || pagesWithXhr > 0 || totalForms > 0) {
    riskLevel = 'medium';
  }

  return { evidence, reasons: [...reasonSet], riskLevel };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the DIAGNOSTIC stage.
 *
 * Analyses rendered HTML from every page to detect signals that indicate
 * the site may be difficult to fully staticise.  Returns a `DiagnosticResult`
 * (risk_level + reasons + evidence) plus `JobEvent` records for the event log.
 *
 * The function is intentionally non-throwing: individual page failures are
 * recorded as warnings and the pipeline continues.
 */
export function runDiagnostic(jobId: string, options: DiagnosticOptions): DiagnosticRunResult {
  const { pages, siteUrl } = options;
  const events: JobEvent[] = [];

  events.push(
    createDiagnosticEvent(jobId, 'stage_progress', 'DIAGNOSTIC stage started', {
      pageCount: pages.length,
    }),
  );

  const allSignals: Array<{ url: string; signals: PageSignals }> = [];

  for (const page of pages) {
    try {
      const signals = extractPageSignals(page.url, page.html, siteUrl);
      allSignals.push({ url: page.url, signals });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      events.push(
        createDiagnosticEvent(jobId, 'warning', 'Failed to analyse page; skipping', {
          url: page.url,
          reason,
        }),
      );
    }
  }

  const { evidence, reasons, riskLevel } = aggregateSignals(allSignals);

  const diagnostic: DiagnosticResult = {
    riskLevel,
    reasons,
    evidence,
  };

  events.push(
    createDiagnosticEvent(jobId, 'diagnostic_ready', 'Diagnostic complete', {
      riskLevel,
      reasons,
      evidenceCount: evidence.length,
    }),
  );

  return { diagnostic, events };
}
