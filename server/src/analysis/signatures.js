// Deterministic technology signatures. Each matcher inspects collected facts
// and, when it matches, returns the concrete evidence it matched on.
// `weight` expresses how strongly that evidence identifies the technology.

const H = (name, re, weight = 0.9) => (f) => {
  const v = f.headers[name];
  if (v === undefined) return null;
  if (re && !re.test(v)) return null;
  return { kind: 'header', source: 'http', label: `Response header ${name}`, value: v, weight };
};
const COOKIE = (re, weight = 0.75) => (f) => {
  const c = f.cookies.find(c => re.test(c.name));
  return c ? { kind: 'cookie', source: c.source, label: 'Cookie name', value: c.name, weight } : null;
};
const HTML = (re, label, weight = 0.8) => (f) => {
  const m = f.html.match(re);
  return m ? { kind: 'html', source: 'http', label, value: m[0].slice(0, 160), weight } : null;
};
const REQ = (re, weight = 0.9) => (f) => {
  const r = f.requests.find(r => re.test(r.href));
  if (r) return { kind: 'request', source: 'browser', label: `Browser ${r.type} request`, value: r.href, weight };
  const s = f.scriptSrcs.find(src => re.test(src));
  if (s) return { kind: 'script', source: f.domSource, label: 'Script source', value: s, weight };
  return null;
};
const FP = (key, label, weight = 0.95, versionKey) => (f) => {
  const v = f.fp?.[key];
  if (!v) return null;
  const version = versionKey ? f.fp?.[versionKey] : (typeof v === 'string' && v !== 'css' ? v : null);
  return { kind: 'dom', source: 'browser', label, value: version ? `present, version ${version}` : 'present', weight, version: version || undefined };
};
const GEN = (re, weight = 0.9) => (f) => {
  const g = f.generator;
  if (!g || !re.test(g)) return null;
  const version = (g.match(/\d+(\.\d+)+/) || [])[0];
  return { kind: 'meta', source: f.domSource, label: 'meta generator', value: g, weight, version };
};
const DNS = (type, re, weight = 0.8) => (f) => {
  const v = (f.dns?.[type] || []).find(x => re.test(x));
  return v ? { kind: 'dns', source: 'dns', label: `DNS ${type.toUpperCase()} record`, value: v, weight } : null;
};

export const SIGNATURES = [
  // ── CDN / edge networks ────────────────────────────────────────────────
  { id: 'cloudflare', name: 'Cloudflare', category: 'CDN & edge network', layer: 'edge',
    match: [H('cf-ray', null, 0.97), H('server', /cloudflare/i, 0.95), COOKIE(/^(__cf_bm|__cflb|cf_clearance)$/, 0.85), DNS('ns', /\.ns\.cloudflare\.com$/i, 0.6)] },
  { id: 'cloudfront', name: 'Amazon CloudFront', category: 'CDN & edge network', layer: 'edge',
    match: [H('x-amz-cf-id', null, 0.97), H('x-amz-cf-pop', null, 0.95), H('via', /cloudfront/i, 0.95), DNS('cname', /cloudfront\.net$/i, 0.9)] },
  { id: 'fastly', name: 'Fastly', category: 'CDN & edge network', layer: 'edge',
    match: [H('x-fastly-request-id', null, 0.97), H('fastly-debug-digest', null, 0.95), H('x-served-by', /cache-[a-z]{3}/i, 0.85), DNS('cname', /fastly(lb)?\.net$/i, 0.9)] },
  { id: 'akamai', name: 'Akamai', category: 'CDN & edge network', layer: 'edge',
    match: [H('server', /akamai/i, 0.95), H('x-akamai-transformed', null, 0.95), DNS('cname', /(edgekey|akamaiedge|edgesuite)\.net$/i, 0.9)] },
  { id: 'vercel', name: 'Vercel', category: 'Hosting & edge platform', layer: 'edge',
    match: [H('x-vercel-id', null, 0.98), H('x-vercel-cache', null, 0.95), H('server', /^vercel$/i, 0.95), DNS('cname', /vercel-dns\.com$/i, 0.9)] },
  { id: 'netlify', name: 'Netlify', category: 'Hosting & edge platform', layer: 'edge',
    match: [H('x-nf-request-id', null, 0.98), H('server', /netlify/i, 0.95), DNS('cname', /netlify\.(app|com)$/i, 0.9)] },
  { id: 'azure-front-door', name: 'Azure Front Door / Azure CDN', category: 'CDN & edge network', layer: 'edge',
    match: [H('x-azure-ref', null, 0.95), H('x-msedge-ref', null, 0.85), DNS('cname', /(azurefd|azureedge|trafficmanager)\.net$/i, 0.9)] },
  { id: 'google-frontend', name: 'Google Front End', category: 'Edge load balancer', layer: 'edge',
    match: [H('server', /^(gws|google frontend|esf|sffe)$/i, 0.9), H('via', /\bgoogle\b/i, 0.85)] },
  { id: 'bunny', name: 'Bunny CDN', category: 'CDN & edge network', layer: 'edge',
    match: [H('server', /bunnycdn/i, 0.95), H('cdn-pullzone', null, 0.9)] },
  { id: 'sucuri', name: 'Sucuri WAF', category: 'Web application firewall', layer: 'edge',
    match: [H('x-sucuri-id', null, 0.95), H('server', /sucuri/i, 0.95)] },
  { id: 'imperva', name: 'Imperva / Incapsula', category: 'Web application firewall', layer: 'edge',
    match: [H('x-iinfo', null, 0.9), H('x-cdn', /incapsula|imperva/i, 0.95), COOKIE(/^(visid_incap_|incap_ses_)/, 0.9)] },
  { id: 'varnish', name: 'Varnish cache', category: 'HTTP cache', layer: 'edge',
    match: [H('x-varnish', null, 0.9), H('via', /varnish/i, 0.85)] },

  // ── Hosting platforms ──────────────────────────────────────────────────
  { id: 'github-pages', name: 'GitHub Pages', category: 'Static hosting', layer: 'hosting',
    match: [H('server', /^github\.com$/i, 0.95), H('x-github-request-id', null, 0.8)] },
  { id: 'heroku', name: 'Heroku', category: 'Application platform', layer: 'hosting',
    match: [H('via', /vegur/i, 0.9), DNS('cname', /herokudns\.com$/i, 0.9)] },
  { id: 'flyio', name: 'Fly.io', category: 'Application platform', layer: 'hosting',
    match: [H('fly-request-id', null, 0.95), H('server', /^fly\//i, 0.95)] },
  { id: 'render', name: 'Render', category: 'Application platform', layer: 'hosting',
    match: [H('x-render-origin-server', null, 0.9), H('rndr-id', null, 0.95)] },
  { id: 's3', name: 'Amazon S3', category: 'Object storage hosting', layer: 'hosting',
    match: [H('server', /^amazons3$/i, 0.95), H('x-amz-request-id', null, 0.6)] },
  { id: 'aws-elb', name: 'AWS Elastic Load Balancing', category: 'Load balancer', layer: 'hosting',
    match: [H('server', /^awselb/i, 0.95), COOKIE(/^AWSALB(CORS)?$/, 0.9)] },
  { id: 'aws-apigw', name: 'Amazon API Gateway', category: 'API gateway', layer: 'api',
    match: [H('x-amz-apigw-id', null, 0.95), H('x-amzn-requestid', null, 0.6)] },
  { id: 'gcp-trace', name: 'Google Cloud (serving infrastructure)', category: 'Cloud platform', layer: 'hosting',
    match: [H('x-cloud-trace-context', null, 0.8), DNS('cname', /ghs\.googlehosted\.com$/i, 0.9)] },
  { id: 'azure-app-service', name: 'Azure App Service', category: 'Application platform', layer: 'hosting',
    match: [COOKIE(/^ARRAffinity(SameSite)?$/, 0.9), DNS('cname', /azurewebsites\.net$/i, 0.95)] },
  { id: 'firebase-hosting', name: 'Firebase Hosting', category: 'Static hosting', layer: 'hosting',
    match: [DNS('cname', /(firebaseapp\.com|web\.app)$/i, 0.9)] },
  { id: 'shopify-platform', name: 'Shopify', category: 'Commerce platform', layer: 'hosting',
    match: [H('x-shopid', null, 0.95), H('x-shopify-stage', null, 0.95), FP('shopify', 'window.Shopify global', 0.9), REQ(/cdn\.shopify\.com/i, 0.85)] },
  { id: 'wix', name: 'Wix', category: 'Website builder', layer: 'hosting',
    match: [H('x-wix-request-id', null, 0.95), FP('wix', 'Wix runtime global', 0.9)] },
  { id: 'squarespace', name: 'Squarespace', category: 'Website builder', layer: 'hosting',
    match: [H('server', /squarespace/i, 0.95), FP('squarespace', 'Squarespace context global', 0.9)] },
  { id: 'webflow', name: 'Webflow', category: 'Website builder', layer: 'hosting',
    match: [FP('webflow', 'html[data-wf-site] attribute', 0.95), HTML(/data-wf-site="[^"]+"/, 'Webflow site attribute', 0.95)] },
  { id: 'wpengine', name: 'WP Engine', category: 'Managed WordPress hosting', layer: 'hosting',
    match: [H('x-powered-by', /wp engine/i, 0.95)] },
  { id: 'kinsta', name: 'Kinsta', category: 'Managed WordPress hosting', layer: 'hosting',
    match: [H('x-kinsta-cache', null, 0.95)] },
  { id: 'pantheon', name: 'Pantheon', category: 'Managed CMS hosting', layer: 'hosting',
    match: [H('x-pantheon-styx-hostname', null, 0.95)] },

  // ── Web servers / proxies ──────────────────────────────────────────────
  { id: 'nginx', name: 'nginx', category: 'Web server / reverse proxy', layer: 'origin',
    match: [H('server', /^nginx/i, 0.9)], version: (f) => (f.headers.server?.match(/nginx\/([\d.]+)/i) || [])[1] },
  { id: 'openresty', name: 'OpenResty', category: 'Web server / reverse proxy', layer: 'origin',
    match: [H('server', /openresty/i, 0.9)] },
  { id: 'apache', name: 'Apache HTTP Server', category: 'Web server', layer: 'origin',
    match: [H('server', /^apache(?!-coyote)/i, 0.9)], version: (f) => (f.headers.server?.match(/apache\/([\d.]+)/i) || [])[1] },
  { id: 'iis', name: 'Microsoft IIS', category: 'Web server', layer: 'origin',
    match: [H('server', /microsoft-iis/i, 0.95)], version: (f) => (f.headers.server?.match(/iis\/([\d.]+)/i) || [])[1] },
  { id: 'litespeed', name: 'LiteSpeed', category: 'Web server', layer: 'origin', match: [H('server', /litespeed/i, 0.95)] },
  { id: 'caddy', name: 'Caddy', category: 'Web server', layer: 'origin', match: [H('server', /^caddy/i, 0.95)] },
  { id: 'envoy', name: 'Envoy proxy', category: 'Service proxy', layer: 'origin',
    match: [H('server', /^envoy$/i, 0.9), H('x-envoy-upstream-service-time', null, 0.9)] },
  { id: 'kestrel', name: 'Kestrel (ASP.NET Core)', category: 'Application server', layer: 'backend', match: [H('server', /kestrel/i, 0.95)] },
  { id: 'gunicorn', name: 'Gunicorn (Python)', category: 'Application server', layer: 'backend', match: [H('server', /gunicorn/i, 0.95)] },
  { id: 'uvicorn', name: 'Uvicorn (Python ASGI)', category: 'Application server', layer: 'backend', match: [H('server', /uvicorn/i, 0.95)] },
  { id: 'tomcat', name: 'Apache Tomcat / Coyote', category: 'Application server', layer: 'backend', match: [H('server', /apache-coyote|tomcat/i, 0.9)] },

  // ── Backend frameworks / runtimes (only from explicit signals) ─────────
  { id: 'express', name: 'Express (Node.js)', category: 'Backend framework', layer: 'backend', match: [H('x-powered-by', /express/i, 0.95)] },
  { id: 'php', name: 'PHP', category: 'Backend runtime', layer: 'backend',
    match: [H('x-powered-by', /php/i, 0.95), COOKIE(/^PHPSESSID$/, 0.85)], version: (f) => (f.headers['x-powered-by']?.match(/php\/([\d.]+)/i) || [])[1] },
  { id: 'aspnet', name: 'ASP.NET', category: 'Backend framework', layer: 'backend',
    match: [H('x-powered-by', /asp\.net/i, 0.9), H('x-aspnet-version', null, 0.95), COOKIE(/^(ASP\.NET_SessionId|\.AspNetCore\.)/i, 0.9)] },
  { id: 'java-servlet', name: 'Java servlet container', category: 'Backend runtime', layer: 'backend', match: [COOKIE(/^JSESSIONID$/, 0.85)] },
  { id: 'django', name: 'Django', category: 'Backend framework', layer: 'backend',
    match: [COOKIE(/^csrftoken$/, 0.6), HTML(/name=["']csrfmiddlewaretoken["']/, 'Django CSRF form field', 0.9)] },
  { id: 'rails', name: 'Ruby on Rails', category: 'Backend framework', layer: 'backend',
    match: [HTML(/<meta name=["']csrf-param["'] content=["']authenticity_token["']/, 'Rails CSRF meta tag', 0.9), H('x-runtime', /^\d+\.\d+$/, 0.5)] },
  { id: 'laravel', name: 'Laravel', category: 'Backend framework', layer: 'backend', match: [COOKIE(/^laravel_session$/, 0.95)] },
  { id: 'next-server', name: 'Next.js server runtime', category: 'Rendering server', layer: 'backend',
    match: [H('x-powered-by', /next\.js/i, 0.95), H('x-nextjs-cache', null, 0.9), H('x-nextjs-prerender', null, 0.9)] },
  { id: 'nuxt-server', name: 'Nuxt server (Nitro)', category: 'Rendering server', layer: 'backend', match: [H('x-powered-by', /nuxt|nitro/i, 0.9)] },
  { id: 'spring', name: 'Spring (Java)', category: 'Backend framework', layer: 'backend', match: [H('x-application-context', null, 0.85)] },

  // ── Frontend frameworks & libraries ────────────────────────────────────
  { id: 'nextjs', name: 'Next.js', category: 'Frontend framework', layer: 'frontend',
    match: [FP('nextData', '__NEXT_DATA__ hydration payload', 0.97, 'nextVersion'), FP('nextAppRouter', 'Next.js App Router flight data (self.__next_f)', 0.95, 'nextVersion'),
      HTML(/\/_next\/static\//, '/_next/static asset path', 0.9), REQ(/\/_next\/static\//, 0.9)] },
  { id: 'react', name: 'React', category: 'UI library', layer: 'frontend',
    match: [FP('reactRoot', 'React root container attached to DOM', 0.95, 'reactVersion'), HTML(/data-reactroot/, 'data-reactroot attribute', 0.9)] },
  { id: 'vue', name: 'Vue.js', category: 'UI framework', layer: 'frontend',
    match: [FP('vue', 'Vue application instance', 0.95, 'vueVersion'), HTML(/\sdata-v-[a-f0-9]{8}/, 'Vue scoped-style attribute', 0.85)] },
  { id: 'nuxt', name: 'Nuxt', category: 'Frontend framework', layer: 'frontend',
    match: [FP('nuxt', 'Nuxt runtime state', 0.95), HTML(/\/_nuxt\//, '/_nuxt/ asset path', 0.9)] },
  { id: 'angular', name: 'Angular', category: 'Frontend framework', layer: 'frontend',
    match: [FP('angularVersion', '[ng-version] attribute', 0.97), HTML(/ng-version="[\d.]+"/, 'ng-version attribute', 0.95)] },
  { id: 'angularjs', name: 'AngularJS (1.x)', category: 'Frontend framework', layer: 'frontend', match: [FP('angularJs', 'window.angular global', 0.95)] },
  { id: 'sveltekit', name: 'SvelteKit', category: 'Frontend framework', layer: 'frontend',
    match: [FP('svelteKit', 'SvelteKit hydration markers', 0.9), HTML(/data-sveltekit-[a-z-]+/, 'SvelteKit data attribute', 0.9)] },
  { id: 'svelte', name: 'Svelte', category: 'UI framework', layer: 'frontend', match: [FP('svelte', 'Svelte scoped class names', 0.75)] },
  { id: 'gatsby', name: 'Gatsby', category: 'Frontend framework', layer: 'frontend',
    match: [FP('gatsby', '#___gatsby root', 0.95), HTML(/id="___gatsby"/, '#___gatsby root element', 0.95)] },
  { id: 'remix', name: 'Remix', category: 'Frontend framework', layer: 'frontend', match: [FP('remix', 'window.__remixContext', 0.95)] },
  { id: 'react-router', name: 'React Router (framework mode)', category: 'Frontend framework', layer: 'frontend', match: [FP('reactRouter', 'window.__reactRouterContext', 0.95)] },
  { id: 'astro', name: 'Astro', category: 'Frontend framework', layer: 'frontend',
    match: [FP('astro', 'Astro island / data-astro markers', 0.95), GEN(/astro/i, 0.95)] },
  { id: 'ember', name: 'Ember.js', category: 'Frontend framework', layer: 'frontend', match: [FP('ember', 'window.Ember global', 0.95)] },
  { id: 'jquery', name: 'jQuery', category: 'JavaScript library', layer: 'frontend', match: [FP('jquery', 'window.jQuery', 0.95), REQ(/jquery[.-][\d.]*(min\.)?js/i, 0.8)] },
  { id: 'solid', name: 'SolidJS', category: 'UI library', layer: 'frontend', match: [FP('solid', 'Solid hydration global _$HY', 0.9)] },
  { id: 'qwik', name: 'Qwik', category: 'Frontend framework', layer: 'frontend', match: [FP('qwik', 'q:container attribute', 0.95)] },
  { id: 'alpine', name: 'Alpine.js', category: 'JavaScript library', layer: 'frontend', match: [FP('alpine', 'Alpine.js global / x-data', 0.85)] },
  { id: 'htmx', name: 'htmx', category: 'JavaScript library', layer: 'frontend', match: [FP('htmx', 'htmx global / hx-* attributes', 0.9)] },
  { id: 'webpack', name: 'webpack', category: 'Build tooling', layer: 'frontend', match: [FP('webpack', 'webpackChunk* runtime global', 0.85)] },
  { id: 'tailwind', name: 'Tailwind CSS', category: 'CSS framework', layer: 'frontend', match: [FP('tailwind', 'Tailwind --tw-* CSS custom properties', 0.85)] },
  { id: 'bootstrap', name: 'Bootstrap', category: 'CSS framework', layer: 'frontend', match: [FP('bootstrap', 'Bootstrap runtime / --bs-* CSS variables', 0.85)] },
  { id: 'wordpress', name: 'WordPress', category: 'CMS', layer: 'frontend',
    match: [GEN(/wordpress/i, 0.95), FP('wordpress', '/wp-content/ assets', 0.9), HTML(/\/wp-(content|includes)\//, '/wp-content/ asset path', 0.9), H('link', /api\.w\.org/i, 0.9)] },
  { id: 'drupal', name: 'Drupal', category: 'CMS', layer: 'frontend', match: [GEN(/drupal/i, 0.95), FP('drupal', 'window.Drupal', 0.9), H('x-generator', /drupal/i, 0.95)] },
  { id: 'hugo', name: 'Hugo', category: 'Static site generator', layer: 'frontend', match: [GEN(/hugo/i, 0.95)] },
  { id: 'jekyll', name: 'Jekyll', category: 'Static site generator', layer: 'frontend', match: [GEN(/jekyll/i, 0.95)] },
  { id: 'docusaurus', name: 'Docusaurus', category: 'Documentation framework', layer: 'frontend', match: [GEN(/docusaurus/i, 0.95)] },
  { id: 'ghost', name: 'Ghost', category: 'CMS', layer: 'frontend', match: [GEN(/ghost/i, 0.95)] },
];

// Third-party services identified by the hosts the browser actually contacted.
export const INTEGRATIONS = [
  ['google-analytics', 'Google Analytics', 'Analytics', /(google-analytics\.com|\/g\/collect|googletagmanager\.com\/gtag\/js)/i],
  ['gtm', 'Google Tag Manager', 'Tag management', /googletagmanager\.com\/gtm\.js/i],
  ['google-fonts', 'Google Fonts', 'Web fonts', /fonts\.(googleapis|gstatic)\.com/i],
  ['recaptcha', 'Google reCAPTCHA', 'Bot protection', /(google\.com|gstatic\.com|recaptcha\.net)\/recaptcha/i],
  ['hcaptcha', 'hCaptcha', 'Bot protection', /hcaptcha\.com/i],
  ['turnstile', 'Cloudflare Turnstile', 'Bot protection', /challenges\.cloudflare\.com/i],
  ['cf-insights', 'Cloudflare Web Analytics', 'Analytics', /static\.cloudflareinsights\.com/i],
  ['stripe', 'Stripe', 'Payments', /(js|api|m)\.stripe\.(com|network)/i],
  ['paypal', 'PayPal', 'Payments', /paypal\.com\/sdk|paypalobjects\.com/i],
  ['sentry', 'Sentry', 'Error monitoring', /(sentry\.io|sentry-cdn\.com)/i],
  ['datadog', 'Datadog RUM', 'Monitoring', /(datadoghq\.(com|eu)|datadoghq-browser-agent)/i],
  ['newrelic', 'New Relic', 'Monitoring', /(js-agent\.newrelic\.com|nr-data\.net)/i],
  ['segment', 'Segment', 'Customer data platform', /(cdn\.segment\.com|api\.segment\.io)/i],
  ['mixpanel', 'Mixpanel', 'Product analytics', /mixpanel\.com/i],
  ['amplitude', 'Amplitude', 'Product analytics', /amplitude\.com/i],
  ['posthog', 'PostHog', 'Product analytics', /posthog\.com/i],
  ['hotjar', 'Hotjar', 'Session analytics', /hotjar\.(com|io)/i],
  ['clarity', 'Microsoft Clarity', 'Session analytics', /clarity\.ms/i],
  ['plausible', 'Plausible Analytics', 'Analytics', /plausible\.io/i],
  ['vercel-analytics', 'Vercel Analytics', 'Analytics', /\/_vercel\/(insights|speed-insights)/i],
  ['adobe-analytics', 'Adobe Experience Cloud', 'Analytics', /(omtrdc\.net|adobedtm\.com|demdex\.net)/i],
  ['optimizely', 'Optimizely', 'Experimentation', /optimizely\.com/i],
  ['launchdarkly', 'LaunchDarkly', 'Feature flags', /launchdarkly\.com/i],
  ['intercom', 'Intercom', 'Customer messaging', /(intercom\.io|intercomcdn\.com)/i],
  ['zendesk', 'Zendesk', 'Customer support', /(zdassets\.com|zendesk\.com)/i],
  ['hubspot', 'HubSpot', 'Marketing automation', /(hs-scripts\.com|hubspot\.com|hsforms\.(com|net)|hs-analytics\.net)/i],
  ['drift', 'Drift', 'Customer messaging', /drift\.com/i],
  ['crisp', 'Crisp', 'Customer messaging', /crisp\.chat/i],
  ['meta-pixel', 'Meta Pixel', 'Advertising', /connect\.facebook\.net|facebook\.com\/tr/i],
  ['linkedin', 'LinkedIn Insight', 'Advertising', /snap\.licdn\.com|px\.ads\.linkedin\.com/i],
  ['tiktok', 'TikTok Pixel', 'Advertising', /analytics\.tiktok\.com/i],
  ['google-ads', 'Google Ads / DoubleClick', 'Advertising', /(doubleclick\.net|googleadservices\.com|googlesyndication\.com)/i],
  ['x-ads', 'X (Twitter) widgets/ads', 'Advertising', /(platform\.twitter\.com|static\.ads-twitter\.com|ads-api\.x\.com)/i],
  ['youtube', 'YouTube embeds', 'Media', /(youtube(-nocookie)?\.com\/(embed|iframe_api)|ytimg\.com)/i],
  ['vimeo', 'Vimeo', 'Media', /(player\.vimeo\.com|vimeocdn\.com)/i],
  ['algolia', 'Algolia', 'Search', /(algolia\.net|algolianet\.com)/i],
  ['auth0', 'Auth0', 'Identity', /auth0\.com/i],
  ['okta', 'Okta', 'Identity', /okta(cdn)?\.com/i],
  ['clerk', 'Clerk', 'Identity', /clerk\.(com|dev|accounts\.dev)/i],
  ['firebase', 'Firebase', 'Backend-as-a-service', /(firebaseio\.com|firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|firebaseinstallations)/i],
  ['supabase', 'Supabase', 'Backend-as-a-service', /supabase\.co/i],
  ['cloudinary', 'Cloudinary', 'Image CDN', /res\.cloudinary\.com/i],
  ['imgix', 'imgix', 'Image CDN', /imgix\.net/i],
  ['contentful', 'Contentful', 'Headless CMS', /(ctfassets\.net|cdn\.contentful\.com)/i],
  ['sanity', 'Sanity', 'Headless CMS', /cdn\.sanity\.io/i],
  ['jsdelivr', 'jsDelivr', 'Public JS CDN', /cdn\.jsdelivr\.net/i],
  ['unpkg', 'unpkg', 'Public JS CDN', /unpkg\.com/i],
  ['cdnjs', 'cdnjs', 'Public JS CDN', /cdnjs\.cloudflare\.com/i],
  ['onetrust', 'OneTrust', 'Consent management', /(cookielaw\.org|onetrust\.com)/i],
  ['cookiebot', 'Cookiebot', 'Consent management', /cookiebot\.com/i],
  ['google-maps', 'Google Maps', 'Maps', /maps\.(googleapis|gstatic)\.com/i],
  ['mapbox', 'Mapbox', 'Maps', /mapbox\.com/i],
  ['typekit', 'Adobe Fonts', 'Web fonts', /use\.typekit\.net/i],
  ['fontawesome', 'Font Awesome', 'Icons', /(kit|use)\.fontawesome\.com/i],
];
