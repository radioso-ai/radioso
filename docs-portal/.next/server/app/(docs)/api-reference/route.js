(()=>{var a={};a.id=198,a.ids=[198],a.modules={261:a=>{"use strict";a.exports=require("next/dist/shared/lib/router/utils/app-paths")},10846:a=>{"use strict";a.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},19225:(a,b,c)=>{"use strict";a.exports=c(44870)},29294:a=>{"use strict";a.exports=require("next/dist/server/app-render/work-async-storage.external.js")},44870:a=>{"use strict";a.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},63033:a=>{"use strict";a.exports=require("next/dist/server/app-render/work-unit-async-storage.external.js")},78335:()=>{},86439:a=>{"use strict";a.exports=require("next/dist/shared/lib/no-fallback-error.external")},87391:(a,b,c)=>{"use strict";let d;c.r(b),c.d(b,{handler:()=>F,patchFetch:()=>E,routeModule:()=>A,serverHooks:()=>D,workAsyncStorage:()=>B,workUnitAsyncStorage:()=>C});var e,f={};c.r(f),c.d(f,{GET:()=>z});var g=c(19225),h=c(84006),i=c(8317),j=c(99373),k=c(34775),l=c(24235),m=c(261),n=c(54365),o=c(90771),p=c(73461),q=c(67798),r=c(92280),s=c(62018),t=c(45696),u=c(47929),v=c(86439),w=c(37527);let x=a=>`[${a.map(a=>"function"==typeof a?a.toString():JSON.stringify(a)).join(", ")}]`;var y=`
/* basic theme */
.dark-mode {
  --scalar-color-1: rgba(255, 255, 255, 0.9);
  --scalar-color-2: rgba(255, 255, 255, 0.62);
  --scalar-color-3: rgba(255, 255, 255, 0.44);
  --scalar-color-accent: #3070ec;

  --scalar-background-1: #000000;
  --scalar-background-2: #1a1a1a;
  --scalar-background-3: #2a2828;
  --scalar-background-accent: transparent;

  --scalar-border-color: rgba(255, 255, 255, 0.1);
}

.light-mode .dark-mode,
.light-mode {
  --scalar-color-1: #1b1b1b;
  --scalar-color-2: #757575;
  --scalar-color-3: #8e8e8e;
  --scalar-color-accent: #3070ec;

  --scalar-background-1: #fff;
  --scalar-background-2: #fafafa;
  --scalar-background-3: #e7e7e7;
  --scalar-background-accent: transparent;

  --scalar-border-color: rgba(0, 0, 0, 0.1);
}
.light-mode .scalar-card {
  --scalar-background-1: #fff;
  --scalar-background-2: #fff !important;
  --scalar-background-3: #fff !important;
}
.dark-mode .scalar-card {
  --scalar-background-1: #000000;
  --scalar-background-2: #000000 !important;
  --scalar-background-3: #000000 !important;
}
.light-mode .examples .scalar-card .scalar-card-header {
  --scalar-background-2: #fafafa;
}
.dark-mode .examples .scalar-card .scalar-card-header {
  --scalar-background-2: #1a1a1a;
  --scalar-border-color: #1a1a1a;
}
/* Document header */
.light-mode .t-doc__header,
.dark-mode .t-doc__header {
  --scalar-header-background-1: rgba(255,255,255,.8);
  --scalar-header-border-color: var(--scalar-border-color);
  --scalar-header-color-1: var(--scalar-color-1);
  --scalar-header-color-2: var(--scalar-color-2);
  --scalar-header-background-toggle: var(--scalar-color-3);
  --scalar-header-call-to-action-color: var(--scalar-color-accent);
  backdrop-filter: saturate(180%) blur(5px);
}

.dark-mode .t-doc__header {
  --scalar-header-background-1: rgba(0,0,0,.5);
}
/* Document Sidebar */
.light-mode .t-doc__sidebar,
.dark-mode .t-doc__sidebar {
  --scalar-sidebar-background-1: var(--scalar-background-1);
  --scalar-sidebar-item-hover-color: var(--scalar-sidebar-color-1);
  --scalar-sidebar-item-hover-background: transparent;
  --scalar-sidebar-item-active-background: var(--scalar-background-accent);
  --scalar-sidebar-border-color: transparent;
  --scalar-sidebar-color-1: var(--scalar-color-1);
  --scalar-sidebar-color-2: var(--scalar-color-2);
  --scalar-sidebar-color-active: var(--scalar-color-accent);
  --scalar-sidebar-search-background: var(--scalar-background-2);
  --scalar-sidebar-search-border-color: var(--scalar-background-2);
  --scalar-sidebar-search-color: var(--scalar-color-3);
  --scalar-sidebar-indent-border: var(--scalar-border-color);
  --scalar-sidebar-indent-border-active: #6aacf8;
}
.api-client-drawer .t-doc__sidebar {
  --scalar-sidebar-border-color: var(--scalar-border-color);
}
/* advanced */
.light-mode .dark-mode,
.light-mode {
  --scalar-button-1: rgb(49 53 56);
  --scalar-button-1-color: #fff;
  --scalar-button-1-hover: rgb(28 31 33);

  --scalar-color-green: #417942;
  --scalar-color-red: #ae3763;
  --scalar-color-yellow: #edbe20;
  --scalar-color-blue: #2b66cf;
  --scalar-color-orange: #cf7a2b;
  --scalar-color-purple: #6e27b5;

  --scalar-scrollbar-color: rgba(0, 0, 0, 0.18);
  --scalar-scrollbar-color-active: rgba(0, 0, 0, 0.36);
}
.dark-mode {
  --scalar-button-1: #f6f6f6;
  --scalar-button-1-color: #000;
  --scalar-button-1-hover: #e7e7e7;

  --scalar-color-green: #7abe7b;
  --scalar-color-red: #e5698f;
  --scalar-color-yellow: #f8ea68;
  --scalar-color-blue: #68a6f8;
  --scalar-color-orange: #f89c68;
  --scalar-color-purple: #b57de9;

  --scalar-scrollbar-color: rgba(255, 255, 255, 0.24);
  --scalar-scrollbar-color-active: rgba(255, 255, 255, 0.48);
}
.sidebar .sidebar-indent-nested .sidebar-heading {
  padding-right: 0;
}
.sidebar-search-key {
  background: var(--scalar-background-1) !important;
  border: 1px solid var(--scalar-border-color);
}
`;let z=(e={url:"/openapi.json",theme:"deepSpace",layout:"modern",defaultHttpClient:{targetKey:"node",clientKey:"fetch"},pageTitle:"Radioso API Reference"},d={_integration:"nextjs",...e},()=>{let{cdn:a,pageTitle:b,...c}=d;return new Response(function(a,b=""){let c,d,{config:e,pageTitle:f,cdn:g}=a,h=(f??"Scalar API Reference").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),{customCss:i,theme:j,...k}=(Array.isArray(e)?e[0]:e)??{},l=("function"==typeof(c={...k,...j?{theme:j}:{},...void 0!==i?{customCss:i}:{}}).content&&(c.content=c.content()),c.content&&c.url&&delete c.content,c);return`<!doctype html>
<html>
  <head>
    <title>${h}</title>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />${d=[],(l.customCss&&(d.push("/* Custom CSS */"),d.push(l.customCss)),!l.theme&&b&&(d.push("/* Custom Theme */"),d.push(b)),0===d.length)?"":`
    <style type="text/css">
      ${((a,b=2,c=!1)=>{let d=" ".repeat(b);return a.split("\n").map((a,b)=>0!==b||c?`${d}${a}`:a).join("\n")})(d.join("\n\n"),6)}
    </style>`}
  </head>
  <body>
    <div id="app"></div>${function(a,b){let c={...a},d=[];for(let[b,e]of Object.entries(a))"function"==typeof e?(d.push(`"${b}": ${e.toString()}`),delete c[b]):Array.isArray(e)&&e.some(a=>"function"==typeof a)&&(d.push(`"${b}": ${x(e)}`),delete c[b]);let e=JSON.stringify(c,null,2),f=e.split("\n").map((a,b)=>0===b?a:`      ${a}`).join("\n"),g=f;if(d.length>0)if("{}"===e)g=`{
        ${d.join(",\n        ")}
      }`;else{let a=f.split("\n").slice(0,-1).join("\n");g=`${a},
        ${d.join(",\n        ")}
      }`}return`
    <!-- Load the Script -->
    <script src="${b??"https://cdn.jsdelivr.net/npm/@scalar/api-reference"}"></script>

    <!-- Initialize the Scalar API Reference -->
    <script type="text/javascript">
      Scalar.createApiReference('#app', ${g})
    </script>`}(l,g)}
  </body>
</html>`}({config:c,pageTitle:b,cdn:a},y),{status:200,headers:{"Content-Type":"text/html"}})}),A=new g.AppRouteRouteModule({definition:{kind:h.RouteKind.APP_ROUTE,page:"/(docs)/api-reference/route",pathname:"/api-reference",filename:"route",bundlePath:"app/(docs)/api-reference/route"},distDir:".next",relativeProjectDir:"",resolvedPagePath:"/Users/dm/conductor/workspaces/radioso/toronto/docs-portal/app/(docs)/api-reference/route.ts",nextConfigOutput:"",userland:f,...{}}),{workAsyncStorage:B,workUnitAsyncStorage:C,serverHooks:D}=A;function E(){return(0,i.patchFetch)({workAsyncStorage:B,workUnitAsyncStorage:C})}async function F(a,b,c){c.requestMeta&&(0,j.setRequestMeta)(a,c.requestMeta),A.isDev&&(0,j.addRequestMeta)(a,"devRequestTimingInternalsEnd",process.hrtime.bigint());let d="/(docs)/api-reference/route";"/index"===d&&(d="/");let e=await A.prepare(a,b,{srcPage:d,multiZoneDraftMode:!1});if(!e)return b.statusCode=400,b.end("Bad Request"),null==c.waitUntil||c.waitUntil.call(c,Promise.resolve()),null;let{buildId:f,params:g,nextConfig:i,parsedUrl:x,isDraftMode:y,prerenderManifest:z,routerServerContext:B,isOnDemandRevalidate:C,revalidateOnlyGenerated:D,resolvedPathname:E,clientReferenceManifest:F,serverActionsManifest:G}=e,H=(0,m.normalizeAppPath)(d),I=!!(z.dynamicRoutes[H]||z.routes[E]),J=async()=>((null==B?void 0:B.render404)?await B.render404(a,b,x,!1):b.end("This page could not be found"),null);if(I&&!y){let a=!!z.routes[E],b=z.dynamicRoutes[H];if(b&&!1===b.fallback&&!a){if(i.adapterPath)return await J();throw new v.NoFallbackError}}let K=null;!I||A.isDev||y||(K="/index"===(K=E)?"/":K);let L=!0===A.isDev||!I,M=I&&!L;G&&F&&(0,l.setManifestsSingleton)({page:d,clientReferenceManifest:F,serverActionsManifest:G});let N=a.method||"GET",O=(0,k.getTracer)(),P=O.getActiveScopeSpan(),Q=!!(null==B?void 0:B.isWrappedByNextServer),R=!!(0,j.getRequestMeta)(a,"minimalMode"),S=(0,j.getRequestMeta)(a,"incrementalCache")||await A.getIncrementalCache(a,i,z,R);null==S||S.resetRequestCache(),globalThis.__incrementalCache=S;let T={params:g,previewProps:z.preview,renderOpts:{experimental:{authInterrupts:!!i.experimental.authInterrupts},cacheComponents:!!i.cacheComponents,supportsDynamicResponse:L,incrementalCache:S,cacheLifeProfiles:i.cacheLife,waitUntil:c.waitUntil,onClose:a=>{b.on("close",a)},onAfterTaskError:void 0,onInstrumentationRequestError:(b,c,d,e)=>A.onRequestError(a,b,d,e,B)},sharedContext:{buildId:f}},U=new n.NodeNextRequest(a),V=new n.NodeNextResponse(b),W=o.NextRequestAdapter.fromNodeNextRequest(U,(0,o.signalFromNodeResponse)(b));try{let e,f=async a=>A.handle(W,T).finally(()=>{if(!a)return;a.setAttributes({"http.status_code":b.statusCode,"next.rsc":!1});let c=O.getRootSpanAttributes();if(!c)return;if(c.get("next.span_type")!==p.BaseServerSpan.handleRequest)return void console.warn(`Unexpected root span type '${c.get("next.span_type")}'. Please report this Next.js issue https://github.com/vercel/next.js`);let f=c.get("next.route");if(f){let b=`${N} ${f}`;a.setAttributes({"next.route":f,"http.route":f,"next.span_name":b}),a.updateName(b),e&&e!==a&&(e.setAttribute("http.route",f),e.updateName(b))}else a.updateName(`${N} ${d}`)}),g=async e=>{var g,j;let k=async({previousCacheEntry:g})=>{try{if(!R&&C&&D&&!g)return b.statusCode=404,b.setHeader("x-nextjs-cache","REVALIDATED"),b.end("This page could not be found"),null;let d=await f(e);a.fetchMetrics=T.renderOpts.fetchMetrics;let h=T.renderOpts.pendingWaitUntil;h&&c.waitUntil&&(c.waitUntil(h),h=void 0);let i=T.renderOpts.collectedTags;if(!I)return await (0,r.I)(U,V,d,T.renderOpts.pendingWaitUntil),null;{let a=await d.blob(),b=(0,s.toNodeOutgoingHttpHeaders)(d.headers);i&&(b[u.NEXT_CACHE_TAGS_HEADER]=i),!b["content-type"]&&a.type&&(b["content-type"]=a.type);let c=void 0!==T.renderOpts.collectedRevalidate&&!(T.renderOpts.collectedRevalidate>=u.INFINITE_CACHE)&&T.renderOpts.collectedRevalidate,e=void 0===T.renderOpts.collectedExpire||T.renderOpts.collectedExpire>=u.INFINITE_CACHE?void 0:T.renderOpts.collectedExpire;return{value:{kind:w.CachedRouteKind.APP_ROUTE,status:d.status,body:Buffer.from(await a.arrayBuffer()),headers:b},cacheControl:{revalidate:c,expire:e}}}}catch(b){throw(null==g?void 0:g.isStale)&&await A.onRequestError(a,b,{routerKind:"App Router",routePath:d,routeType:"route",revalidateReason:(0,q.c)({isStaticGeneration:M,isOnDemandRevalidate:C})},!1,B),b}},l=await A.handleResponse({req:a,nextConfig:i,cacheKey:K,routeKind:h.RouteKind.APP_ROUTE,isFallback:!1,prerenderManifest:z,isRoutePPREnabled:!1,isOnDemandRevalidate:C,revalidateOnlyGenerated:D,responseGenerator:k,waitUntil:c.waitUntil,isMinimalMode:R});if(!I)return null;if((null==l||null==(g=l.value)?void 0:g.kind)!==w.CachedRouteKind.APP_ROUTE)throw Object.defineProperty(Error(`Invariant: app-route received invalid cache entry ${null==l||null==(j=l.value)?void 0:j.kind}`),"__NEXT_ERROR_CODE",{value:"E701",enumerable:!1,configurable:!0});R||b.setHeader("x-nextjs-cache",C?"REVALIDATED":l.isMiss?"MISS":l.isStale?"STALE":"HIT"),y&&b.setHeader("Cache-Control","private, no-cache, no-store, max-age=0, must-revalidate");let m=(0,s.fromNodeOutgoingHttpHeaders)(l.value.headers);return R&&I||m.delete(u.NEXT_CACHE_TAGS_HEADER),!l.cacheControl||b.getHeader("Cache-Control")||m.get("Cache-Control")||m.set("Cache-Control",(0,t.getCacheControlHeader)(l.cacheControl)),await (0,r.I)(U,V,new Response(l.value.body,{headers:m,status:l.value.status||200})),null};Q&&P?await g(P):(e=O.getActiveScopeSpan(),await O.withPropagatedContext(a.headers,()=>O.trace(p.BaseServerSpan.handleRequest,{spanName:`${N} ${d}`,kind:k.SpanKind.SERVER,attributes:{"http.method":N,"http.target":a.url}},g),void 0,!Q))}catch(b){if(b instanceof v.NoFallbackError||await A.onRequestError(a,b,{routerKind:"App Router",routePath:H,routeType:"route",revalidateReason:(0,q.c)({isStaticGeneration:M,isOnDemandRevalidate:C})},!1,B),I)throw b;return await (0,r.I)(U,V,new Response(null,{status:500})),null}}},92280:(a,b,c)=>{"use strict";Object.defineProperty(b,"I",{enumerable:!0,get:function(){return g}});let d=c(28208),e=c(47617),f=c(62018);async function g(a,b,c,g){if((0,d.isNodeNextResponse)(b)){var h;b.statusCode=c.status,b.statusMessage=c.statusText;let d=["set-cookie","www-authenticate","proxy-authenticate","vary"];null==(h=c.headers)||h.forEach((a,c)=>{if("x-middleware-set-cookie"!==c.toLowerCase())if("set-cookie"===c.toLowerCase())for(let d of(0,f.splitCookiesString)(a))b.appendHeader(c,d);else{let e=void 0!==b.getHeader(c);(d.includes(c.toLowerCase())||!e)&&b.appendHeader(c,a)}});let{originalResponse:i}=b;c.body&&"HEAD"!==a.method?await (0,e.pipeToNodeResponse)(c.body,i,g):i.end()}}},96487:()=>{}};var b=require("../../../webpack-runtime.js");b.C(a);var c=b.X(0,[741],()=>b(b.s=87391));module.exports=c})();