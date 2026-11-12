// Six themes that differ in surface hue as well as accent (audit 5.39). Retired themes map to their nearest survivor.
// Applies the saved colour theme (data-theme) and light/dark mode (data-mode) from tokens.css to <html>.
// Mode preference: light | dark | system. Syncs across open pages. Alt+Shift+T cycles themes, Alt+Shift+L toggles mode.
(function(){var K='pom-theme',MK='pom-mode',L=['obsidian','midnight','verdigris','nocturne','saffron','umber'],LEGACY={ivory:'obsidian',porcelain:'obsidian',jade:'verdigris',frost:'midnight',amethyst:'nocturne',crimson:'saffron'},d=document.documentElement,mq=window.matchMedia?matchMedia('(prefers-color-scheme: light)'):null;
function g(k){try{return localStorage.getItem(k)}catch(e){return null}}
function s(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function theme(){var t=g(K);if(LEGACY[t])t=LEGACY[t];return L.indexOf(t)>=0?t:'obsidian'}
function pref(){var m=g(MK);if(m==='light'||m==='dark'||m==='system')return m;var t=g(K);return t==='ivory'||t==='porcelain'?'light':'dark'}
function apply(){var p=pref();d.setAttribute('data-theme',theme());d.setAttribute('data-mode-pref',p);d.setAttribute('data-mode',p==='system'?(mq&&mq.matches?'light':'dark'):p)}
apply();
window.pomThemes=L;
window.pomSetTheme=function(t){if(!g(MK))s(MK,pref());s(K,t);apply()};
window.pomSetMode=function(m){s(MK,m);apply()};
window.pomGetMode=function(){return {pref:pref(),mode:d.getAttribute('data-mode')}};
if(mq&&mq.addEventListener)mq.addEventListener('change',function(){if(pref()==='system')apply()});
var TK='pom-texture',TL=['off','subtle','stone'];function tx(v){d.setAttribute('data-texture',TL.indexOf(v)>=0?v:'subtle')}
tx(g(TK));
window.pomSetTexture=function(v){s(TK,v);tx(v)};
var DK='pom-density';function dn(v){d.setAttribute('data-density-pref',v==='compact'?'compact':'comfortable')}dn(g(DK));window.pomSetDensity=function(v){s(DK,v);dn(v)};window.addEventListener('storage',function(e){if(e.key===K||e.key===MK)apply();if(e.key===TK)tx(e.newValue)});
document.addEventListener('keydown',function(e){if(!(e.altKey&&e.shiftKey))return;if(e.code==='KeyT'){e.preventDefault();window.pomSetTheme(L[(L.indexOf(d.getAttribute('data-theme'))+1)%L.length])}else if(e.code==='KeyL'){e.preventDefault();window.pomSetMode(d.getAttribute('data-mode')==='light'?'dark':'light')}});})();
