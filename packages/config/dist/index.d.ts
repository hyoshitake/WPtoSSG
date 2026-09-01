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
export declare const DOMAIN_RULE: DomainRule;
export declare const DEFAULT_DOMAIN_RULE: DomainRule;
export declare const CDN_MAPPINGS: Record<string, string>;
export declare const STATIC_CONVERSION_RULE: StaticConversionRule;
export declare const DEFAULT_CDN_MAPPINGS: Record<string, string>;
export declare const DEFAULT_STATIC_CONVERSION_RULES: StaticConversionRule;
export declare function normalizeUrl(url: string): string;
export declare function isWithinSiteDomain(candidate: string, siteUrl: string, rule?: Partial<DomainRule>): boolean;
export declare function resolveCdnMapping(url: string): string | undefined;
export declare function shouldTreatAsStaticAsset(url: string): boolean;
export declare const siteConfig: {
    domain: DomainRule;
    cdn: Record<string, string>;
    staticRules: StaticConversionRule;
};
export declare const DEFAULT_CONFIG: {
    domain: DomainRule;
    cdn: Record<string, string>;
    staticRules: StaticConversionRule;
};
export default siteConfig;
//# sourceMappingURL=index.d.ts.map