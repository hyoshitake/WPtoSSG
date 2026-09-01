# Requirements and Responsibility Boundaries

This document is the consolidated source of truth for Issue 1.

## Target scope

- Public WordPress sites that do not require login
- Sites under the same domain
- Sites that can be handled within the current MVP limit of fewer than 100 pages
- Graph-based crawling rather than URL-list-only processing
- Static HTML rendering after Playwright execution
- Internal asset collection and local rewriting
- Diagnostics for staticization difficulty
- Google Drive output with `current` and `archive` rotation

## Non-goals

- Bypassing login or access restrictions
- Supporting sites outside the current domain boundary
- Large-scale crawls beyond the MVP page limit
- CMS migration or content editing for WordPress itself
- Rewriting external links by default
- Replacing the existing Google Drive storage model
- Treating diagnostics as definitive judgments without evidence

## Definition of done

- A single public WordPress site under 100 pages can be processed end to end
- The output lands under `/sites/{siteKey}/current`
- A second run rotates the previous `current` into `archive`
- SSE can surface progress and completion states
- Diagnostics return `risk_level`, `reasons`, and `evidence`
- The final report records success and failure details

## Responsibility boundaries

### apps/web

- Job creation and status display
- SSE event delivery and reconnection handling
- Result and diagnostic presentation
- No Playwright, crawl, or Drive heavy lifting

### apps/worker

- BullMQ job execution
- Crawl, render, snapshot, asset handling, diagnostics, and Drive writes
- Retry-friendly handling of page-level failures
- No UI rendering or client-facing orchestration

### packages/shared

- Shared types and schemas for jobs, stages, graphs, and diagnostics
- Request and response contracts used by both web and worker
- No environment-specific logic or I/O

### packages/config

- Domain rules
- CDN mapping
- Staticization rule settings
- No runtime job execution

### infra

- Database, queue, and storage provisioning
- Deployment and operational wiring
- No product logic

### docs

- Architecture, operations, diagnostics, and boundary clarifications
- Definition of done and implementation notes
- No runtime code

