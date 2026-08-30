(function(){
  "use strict";

  var cfg = window.BIDAMAX_PLAYER_CONFIG || {};
  var frame = document.getElementById("playerFrame");
  var titleEl = document.getElementById("movieTitle");
  var loading = document.getElementById("loading");
  var errorBox = document.getElementById("errorBox");
  var errorMessage = document.getElementById("errorMessage");
  var retryBtn = document.getElementById("retryBtn");
  var qualityBtn = document.getElementById("qualityBtn");
  var qualityPanel = document.getElementById("qualityPanel");
  var notPlayingBtn = document.getElementById("notPlayingBtn");
  var topGradient = document.getElementById("topGradient");

  var source = "";
  var title = "Now Playing";
  var good = [];
  var candidates = [];
  var selectedIndex = -1;
  var cacheState = "";
  var forceRefreshAttempted = false;
  var loadingRequest = false;
  var overlayTimer = null;
  var probeGeneration = 0;

  function q(name){ return new URLSearchParams(location.search).get(name) || ""; }
  function clean(v){ return String(v || "").trim(); }
  function lower(v){ return clean(v).toLowerCase(); }
  function isTerabox(v){
    var s=lower(v);
    return ["terabox","1024tera","terashare","nephobox","freeterabox","teraboxapp","4funbox","mirrobox","momerybox","teraboxlink"].some(function(k){return s.indexOf(k)>=0;});
  }
  function normalizeDirect(v){
    var raw=clean(v), lo=lower(raw);
    var idOnly=lo.indexOf("http://")!==0 && lo.indexOf("https://")!==0 && raw.indexOf("/")<0 && raw.indexOf(".")<0 && raw.length>=5;
    if(idOnly) raw="https://player.bidamax.org/"+raw;
    raw=raw.replace(/^https?:\/\/abyssplayer\.com\//i,"https://player.bidamax.org/");
    return raw;
  }
  function validStreamUrl(v){
    var u=clean(v), lo=lower(u);
    return /^https?:\/\//i.test(u) && u.indexOf("Missing token")<0 && u.indexOf('"error"')<0 && u.indexOf("errno")<0 && lo.indexOf("/api/")<0 && lo.indexOf(".json")<0 && lo.indexOf("pretty")<0 && lo.indexOf("raw.githubusercontent.com")<0;
  }
  function showLoading(){ loading.hidden=false; errorBox.hidden=true; }
  function hideLoading(){ loading.hidden=true; }
  function showError(msg){
    hideLoading();
    frame.src="about:blank";
    errorMessage.textContent=msg || "The stream is temporarily unavailable.";
    errorBox.hidden=false;
    showOverlay();
  }
  function clearOverlayTimer(){ if(overlayTimer){clearTimeout(overlayTimer);overlayTimer=null;} }
  function hideOverlay(){
    topGradient.classList.add("overlay-hidden");
    titleEl.classList.add("overlay-hidden");
    qualityBtn.classList.add("overlay-button-hidden");
    notPlayingBtn.classList.add("overlay-button-hidden");
    qualityPanel.style.display="none";
  }
  function showOverlay(){
    topGradient.classList.remove("overlay-hidden");
    titleEl.classList.remove("overlay-hidden");
    qualityBtn.classList.remove("overlay-button-hidden");
    notPlayingBtn.classList.remove("overlay-button-hidden");
    clearOverlayTimer();
    overlayTimer=setTimeout(hideOverlay, Number(cfg.overlayTimeoutMs)||4300);
  }
  function toggleOverlay(){
    if(titleEl.classList.contains("overlay-hidden")) showOverlay(); else hideOverlay();
  }
  function refreshQualityMenu(){
    qualityPanel.innerHTML="";
    good.forEach(function(item,index){
      var b=document.createElement("button");
      b.type="button";
      b.className="quality-item";
      b.textContent=item.name;
      b.addEventListener("click",function(e){e.stopPropagation();changeQuality(index);});
      qualityPanel.appendChild(b);
    });
    qualityBtn.hidden=good.length===0;
  }
  function changeQuality(index){
    if(index<0 || index>=good.length) return;
    selectedIndex=index;
    frame.src=good[index].url;
    qualityBtn.textContent="Quality: "+good[index].name;
    qualityPanel.style.display="none";
    hideLoading();
    errorBox.hidden=true;
    showOverlay();
  }
  function parseCandidates(obj){
    var list=obj && Array.isArray(obj.list)?obj.list:[];
    if(!list.length) return [];
    var item=list[0]||{}, out=[];
    var fast=item.fast_stream_url;
    ["1080p","720p","480p","360p","240p"].forEach(function(name){
      if(fast && validStreamUrl(fast[name])) out.push({name:name,url:fast[name]});
    });
    if(!out.length && validStreamUrl(item.stream_url)) out.push({name:"Auto",url:item.stream_url});
    return out;
  }
  function shouldProbe(items){
    return items.some(function(i){var n=lower(i.name).replace(/\s/g,"");return n.indexOf("1080")>=0 || n.indexOf("720")>=0;});
  }
  function probeOne(item,generation){
    return new Promise(function(resolve){
      if(generation!==probeGeneration){resolve(null);return;}
      var done=false;
      var v=document.createElement("video");
      v.className="probe-video"; v.preload="metadata"; v.muted=true; v.playsInline=true;
      document.body.appendChild(v);
      function finish(ok){
        if(done) return; done=true; clearTimeout(timer);
        try{v.pause();v.removeAttribute("src");v.load();v.remove();}catch(e){}
        resolve(ok?item:null);
      }
      var timer=setTimeout(function(){
        var d=v.duration;
        finish(v.readyState>=1 && ((isFinite(d)&&d>0)||d===Infinity||v.videoWidth>0));
      },Number(cfg.probeTimeoutMs)||4500);
      v.onerror=function(){finish(false);};
      v.onloadedmetadata=function(){var d=v.duration;if((isFinite(d)&&d>0)||d===Infinity||v.videoWidth>0)finish(true);};
      v.oncanplay=function(){var d=v.duration;if((isFinite(d)&&d>0)||d===Infinity||v.videoWidth>0||v.readyState>=3)finish(true);};
      v.src=item.url; v.load();
    });
  }
  async function probeCandidates(items){
    var generation=++probeGeneration;
    if(!shouldProbe(items)) return items.slice();
    var results=await Promise.all(items.map(function(i){return probeOne(i,generation);}));
    if(generation!==probeGeneration) return [];
    return results.filter(Boolean);
  }
  function cachedState(v){
    var s=String(v||"").toUpperCase();
    return s==="MEMORY-HIT" || s==="HIT" || s==="WAIT-HIT" || s==="WAIT-HIT-2" || s==="HIT-AFTER-LOCK";
  }
  async function apiRequest(forceRefresh){
    var controller=new AbortController();
    var timer=setTimeout(function(){controller.abort();},Number(cfg.requestTimeoutMs)||18000);
    try{
      var response=await fetch(cfg.streamApi,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:source,forceRefresh:!!forceRefresh}),signal:controller.signal,cache:"no-store"});
      var text=await response.text();
      var data;
      try{data=JSON.parse(text);}catch(e){throw new Error("Invalid server response");}
      cacheState=response.headers.get("X-Bidamax-Cache") || data._bidamax_cache || "";
      if(!response.ok) throw new Error(data.message || data.error || ("Server error "+response.status));
      return data;
    } finally { clearTimeout(timer); }
  }
  async function loadTerabox(forceRefresh){
    if(loadingRequest) return;
    loadingRequest=true;
    if(forceRefresh) forceRefreshAttempted=true;
    showLoading(); errorBox.hidden=true; qualityPanel.style.display="none"; qualityBtn.hidden=true;
    try{
      var data=await apiRequest(forceRefresh);
      candidates=parseCandidates(data);
      if(!candidates.length) throw new Error("No valid quality URL was generated.");
      good=await probeCandidates(candidates);
      if(!good.length){
        if(!forceRefreshAttempted && cachedState(cacheState)){
          loadingRequest=false;
          return loadTerabox(true);
        }
        throw new Error("Generated qualities are unavailable or stuck at 0:00.");
      }
      refreshQualityMenu();
      changeQuality(0);
    }catch(err){
      var msg=(err && err.name==="AbortError")?"The player request timed out. Please try again.":(err && err.message?err.message:"Unable to load stream.");
      showError(msg);
    }finally{
      loadingRequest=false;
    }
  }
  function loadDirect(){
    var direct=normalizeDirect(source);
    if(!/^https?:\/\//i.test(direct)){showError("Invalid video link.");return;}
    qualityBtn.hidden=true;
    frame.src=direct;
    hideLoading();
    showOverlay();
  }
  function manualRecovery(){
    if(isTerabox(source)){
      // User explicitly says playback is broken, so replace this exact cached entry.
      loadTerabox(true);
    }else{
      frame.src="about:blank";
      setTimeout(loadDirect,80);
    }
  }

  qualityBtn.addEventListener("click",function(e){
    e.stopPropagation(); showOverlay();
    qualityPanel.style.display=qualityPanel.style.display==="block"?"none":"block";
  });
  notPlayingBtn.addEventListener("click",function(e){e.stopPropagation();manualRecovery();});
  retryBtn.addEventListener("click",function(e){e.stopPropagation(); if(isTerabox(source)) loadTerabox(true); else loadDirect();});
  document.getElementById("player").addEventListener("click",function(e){
    if(e.target===qualityBtn || e.target===notPlayingBtn || qualityPanel.contains(e.target) || e.target===retryBtn) return;
    toggleOverlay();
  });
  document.addEventListener("visibilitychange",function(){if(!document.hidden)showOverlay();});

  source=clean(q("src"));
  title=clean(q("title")) || "Now Playing";
  titleEl.textContent=title;

  if(!source || source.toLowerCase()==="n/a") showError("No video link was provided.");
  else if(isTerabox(source)) loadTerabox(false);
  else loadDirect();
})();
