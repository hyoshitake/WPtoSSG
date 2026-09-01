export const DOMAIN_RULE = {
    allowSubdomains: true,
    treatWwwAsSameSite: true,
    ignoredHosts: ['admin', 'login', 'wp-admin', 'wp-login.php'],
    ignoredPaths: ['/wp-admin', '/wp-login.php', '/wp-json'],
};
export const DEFAULT_DOMAIN_RULE = DOMAIN_RULE;
export const CDN_MAPPINGS = {
    jquery: 'https://cdn.jsdelivr.net/npm/jquery@3.12.4/dist/jquery.min.js',
    react: 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
    'react-dom': 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
    bootstrap: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
    'font-awesome': 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/js/all.min.js',
};
export const STATIC_CONVERSION_RULE = {
    enabled: true,
    preserveExternalLinks: true,
    normalizeQueryStrings: false,
    lazyLoadAttributes: ['data-src', 'data-srcset', 'src', 'srcset', 'href'],
    ignoredPaths: ['/wp-admin', '/wp-login.php', '/wp-json'],
    allowedExtensions: ['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.woff', '.woff2', '.ttf'],
};
export const DEFAULT_CDN_MAPPINGS = CDN_MAPPINGS;
export const DEFAULT_STATIC_CONVERSION_RULES = STATIC_CONVERSION_RULE;
export function normalizeUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.origin + parsed.pathname + parsed.search;
    }
    catch {
        return url.trim();
    }
}
export function isWithinSiteDomain(candidate, siteUrl, rule = {}) {
    const base = new URL(siteUrl);
    const target = new URL(candidate, siteUrl);
    const mergedRule = { ...DOMAIN_RULE, ...rule };
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
export function resolveCdnMapping(url) {
    const normalized = normalizeUrl(url).toLowerCase();
    const match = Object.entries(CDN_MAPPINGS).find(([key]) => normalized.includes(key));
    return match ? match[1] : undefined;
}
export function shouldTreatAsStaticAsset(url) {
    try {
        const parsed = new URL(url);
        const extension = parsed.pathname.split('.').pop()?.toLowerCase();
        return Boolean(extension && STATIC_CONVERSION_RULE.allowedExtensions.includes(`.${extension}`));
    }
    catch {
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
//# sourceMappingURL=index.js.map