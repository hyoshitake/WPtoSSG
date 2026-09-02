export interface DomainRule {
  allowSubdomains: boolean;
  treatWwwAsSameSite: boolean;
  ignoredHosts?: string[];
  ignoredPaths?: string[];
}

export interface StaticConversionRule {
  enabled: boolean;
  preserveExternalLinks: boolean;
  normalizeQueryStrings: boolean;
  lazyLoadAttributes: string[];
  ignoredPaths: string[];
  allowedExtensions: string[];
}

export const DOMAIN_RULE: DomainRule = {
  allowSubdomains: true,
  treatWwwAsSameSite: true,
  ignoredHosts: ['admin', 'login', 'wp-admin', 'wp-login.php'],
  ignoredPaths: ['/wp-admin', '/wp-login.php', '/wp-json'],
};

export const DEFAULT_DOMAIN_RULE: DomainRule = DOMAIN_RULE;

export const CDN_MAPPINGS: Record<string, string> = {
  jquery: 'https://cdn.jsdelivr.net/npm/jquery@3.12.4/dist/jquery.min.js',
  react: 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
  'react-dom': 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
  bootstrap: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'font-awesome': 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/js/all.min.js',
};

export const STATIC_CONVERSION_RULE: StaticConversionRule = {
  enabled: true,
  preserveExternalLinks: true,
  normalizeQueryStrings: false,
  lazyLoadAttributes: ['data-src', 'data-srcset', 'src', 'srcset', 'href'],
  ignoredPaths: ['/wp-admin', '/wp-login.php', '/wp-json'],
  allowedExtensions: ['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.woff', '.woff2', '.ttf'],
};

export const DEFAULT_CDN_MAPPINGS = CDN_MAPPINGS;
export const DEFAULT_STATIC_CONVERSION_RULES = STATIC_CONVERSION_RULE;

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname + parsed.search;
  } catch {
    return url.trim();
  }
}

export function isWithinSiteDomain(candidate: string, siteUrl: string, rule: Partial<DomainRule> = {}): boolean {
  const base = new URL(siteUrl);
  const target = new URL(candidate, siteUrl);

  const mergedRule: DomainRule = { ...DOMAIN_RULE, ...rule };

  if (mergedRule.ignoredHosts?.some((host) => target.hostname.includes(host))) {
    return false;
  }

  if (mergedRule.ignoredPaths?.some((path) => target.pathname.toLowerCase().startsWith(path.toLowerCase()))) {
    return false;
  }

  const sameOrigin = target.origin === base.origin;
  if (sameOrigin) {
    return true;
  }

  const baseHost = base.hostname.toLowerCase();
  const targetHost = target.hostname.toLowerCase();

  if (mergedRule.allowSubdomains) {
    const normalizedBase = baseHost.replace(/^www\./, '');
    const normalizedTarget = targetHost.replace(/^www\./, '');

    if (normalizedTarget === normalizedBase) {
      return true;
    }

    if (normalizedTarget.endsWith(`.${normalizedBase}`)) {
      return true;
    }
  }

  return false;
}

export function resolveCdnMapping(url: string): string | undefined {
  const normalized = normalizeUrl(url).toLowerCase();
  const match = Object.entries(CDN_MAPPINGS).find(([key]) => normalized.includes(key));
  return match ? match[1] : undefined;
}

export function shouldTreatAsStaticAsset(url: string): boolean {
  try {
    const parsed = new URL(url);
    const extension = parsed.pathname.split('.').pop()?.toLowerCase();

    return Boolean(extension && STATIC_CONVERSION_RULE.allowedExtensions.includes(`.${extension}`));
  } catch {
    return false;
  }
}

export const siteConfig = {
  domain: DOMAIN_RULE,
  cdn: CDN_MAPPINGS,
  staticRules: STATIC_CONVERSION_RULE,
};

export const DEFAULT_CONFIG = siteConfig;

export default siteConfig;

export interface GraphNormalizationOptions {
  normalizeQueryStrings?: boolean;
  preserveHash?: boolean;
}

export function normalizeGraphUrl(
  url: string,
  siteUrl?: string,
  options: GraphNormalizationOptions = {},
): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const base = siteUrl ? new URL(trimmed, siteUrl) : new URL(trimmed);
    const normalized = new URL(base.toString());

    normalized.hash = options.preserveHash ? normalized.hash : '';
    if (options.normalizeQueryStrings) {
      normalized.search = '';
    }

    if (normalized.pathname === '') {
      normalized.pathname = '/';
    }

    if (normalized.pathname.length > 1 && normalized.pathname.endsWith('/')) {
      normalized.pathname = normalized.pathname.replace(/\/+$/, '');
    }

    return normalized.toString().replace(/\/$/, '') || `${normalized.origin}/`;
  } catch {
    return trimmed;
  }
}

export function isWithinSiteScope(url: string, siteUrl: string): boolean {
  return isWithinSiteDomain(url, siteUrl, DOMAIN_RULE);
}

export function classifyGraphUrlKind(url: string, siteUrl: string): 'page' | 'asset' | 'api' | 'form' | 'external' {
  try {
    const parsed = new URL(url, siteUrl);
    const pathname = parsed.pathname.toLowerCase();

    if (!isWithinSiteScope(parsed.toString(), siteUrl)) {
      return 'external';
    }

    if (/\.(css|js|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|ico|pdf|zip|mp4|mp3)(?:[?#]|$)/i.test(pathname)) {
      return 'asset';
    }

    if (/\/wp-json\b|\/api\b|graphql|api\./i.test(pathname + parsed.search)) {
      return 'api';
    }

    if (parsed.searchParams.has('s') || /\bform\b|wp-login|login/i.test(pathname + parsed.search)) {
      return 'form';
    }

    return 'page';
  } catch {
    return 'external';
  }
}

export interface CrawlGraphNode {
  id: string;
  url: string;
  kind: 'page' | 'asset' | 'api' | 'form' | 'external';
  status?: 'pending' | 'success' | 'failed';
  metadata?: Record<string, unknown>;
}

export interface CrawlGraphEdge {
  id: string;
  from: string;
  to: string;
  type: 'links_to' | 'loads_asset' | 'calls_api' | 'has_form' | 'references';
  metadata?: Record<string, unknown>;
}

export interface CrawlGraph {
  id: string;
  siteUrl: string;
  nodes: CrawlGraphNode[];
  edges: CrawlGraphEdge[];
  createdAt: string;
  updatedAt: string;
}

export function createGraphNodeId(url: string): string {
  return encodeURIComponent(normalizeGraphUrl(url));
}

export function createGraphNode(
  url: string,
  siteUrl: string,
  kind: CrawlGraphNode['kind'] = classifyGraphUrlKind(url, siteUrl),
  metadata: Record<string, unknown> = {},
): CrawlGraphNode {
  const normalized = normalizeGraphUrl(url, siteUrl);
  return {
    id: createGraphNodeId(normalized),
    url: normalized,
    kind,
    status: 'pending',
    metadata,
  };
}

export function createGraphEdge(
  fromUrl: string,
  toUrl: string,
  type: CrawlGraphEdge['type'] = 'links_to',
  metadata: Record<string, unknown> = {},
): CrawlGraphEdge {
  const fromId = createGraphNodeId(fromUrl);
  const toId = createGraphNodeId(toUrl);

  return {
    id: `${fromId}:${type}:${toId}`,
    from: fromId,
    to: toId,
    type,
    metadata,
  };
}

export function buildCrawlGraph(
  siteUrl: string,
  discoveredUrls: Iterable<string> = [],
  options: {
    normalizeQueryStrings?: boolean;
    includeExternalLinks?: boolean;
  } = {},
): CrawlGraph {
  const timestamp = new Date().toISOString();
  const graph: CrawlGraph = {
    id: createGraphNodeId(siteUrl || 'site'),
    siteUrl: normalizeGraphUrl(siteUrl),
    nodes: [],
    edges: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const rootNode = createGraphNode(siteUrl, siteUrl, 'page', { source: 'root' });
  graph.nodes.push(rootNode);

  const seen = new Set<string>();

  for (const candidate of discoveredUrls) {
    const normalized = normalizeGraphUrl(candidate, siteUrl, { normalizeQueryStrings: Boolean(options.normalizeQueryStrings) });
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    const kind = isWithinSiteScope(normalized, siteUrl) ? classifyGraphUrlKind(normalized, siteUrl) : 'external';
    graph.nodes.push({
      id: createGraphNodeId(normalized),
      url: normalized,
      kind,
      status: 'pending',
      metadata: { source: 'crawl' },
    });

    if (options.includeExternalLinks || kind !== 'external') {
      graph.edges.push(
        createGraphEdge(rootNode.url, normalized, kind === 'external' ? 'references' : 'links_to', {
          discoveredFrom: rootNode.url,
        }),
      );
    }
  }

  return graph;
}

export const createSiteGraph = buildCrawlGraph;
export const createCrawlGraph = buildCrawlGraph;
export const normalizeUrlForGraph = normalizeGraphUrl;
export const isUrlInSiteScope = isWithinSiteScope;
