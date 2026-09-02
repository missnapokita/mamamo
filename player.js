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
  var wakeTop = document.getElementById("wakeTop");
  var wakeBottom = document.getElementById("wakeBottom");
  var wakeLeft = document.getElementById("wakeLeft");
  var wakeRight = document.getElementById("wakeRight");

  var source = "";
  var title = "Now Playing";
  var good = [];
  var candidates = [];
  var selectedIndex = -1;
  var loadingRequest = false;
  var overlayTimer = null;
  var probeGeneration = 0;
  var recoveryLockedUntil = 0;
  var activeLoadToken = 0;
  var reportedDiagnostics = {};
  var lastCacheState = "";
  var lastGenerationState = "";
  var lastRequestId = "";

  function q(name){ return new URLSearchParams(location.search).get(name) || ""; }
  function clean(v){ return String(v || "").trim(); }
  function lower(v){ return clean(v).toLowerCase(); }
  function sourceType(v){
    return isTerabox(v) ? "terabox" : "direct";
  }

  function normalizeDiagnosticMessage(v){
    var s=clean(v).toLowerCase();
    s=s.replace(/https?:\/\/[^\s]+/g,"<url>");
    s=s.replace(/\b\d{3,}\b/g,"#");
    return s.slice(0,180);
  }

  function reportDiagnostic(code,extra){
    try{
      if(!cfg.diagnosticsApi) return;

      extra=extra||{};
      var payload={
        code:clean(code||"PLAYER_ERROR").toUpperCase(),
        step:clean(extra.step||"player"),
        status:Number(extra.status)||0,
        sourceType:sourceType(source),
        cacheState:clean(extra.cacheState||lastCacheState).slice(0,50),
        generationState:clean(extra.generationState||lastGenerationState).slice(0,50),
        message:normalizeDiagnosticMessage(extra.message||""),
        title:clean(title||"").slice(0,120),
        playerVersion:clean(cfg.playerVersion||"v2"),
        requestId:clean(extra.requestId||lastRequestId).slice(0,80)
      };

      /*
       * Same error within the same player session is never posted twice.
       * Server-side GitHub dedupe protects across all users.
       */
      var localKey=[
        payload.code,
        payload.step,
        payload.status,
        payload.sourceType,
        payload.cacheState,
        payload.generationState,
        payload.message,
        payload.playerVersion
      ].join("|");

      if(reportedDiagnostics[localKey]) return;
      reportedDiagnostics[localKey]=true;

      fetch(cfg.diagnosticsApi,{
        method:"POST",
        /* text/plain avoids a separate cross-origin OPTIONS request. */
        headers:{"Content-Type":"text/plain;charset=UTF-8"},
        body:JSON.stringify(payload),
        keepalive:true,
        credentials:"omit",
        cache:"no-store"
      }).catch(function(){});
    }catch(e){}
  }

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
  function showLoading(){
    loading.hidden=false;
    errorBox.hidden=true;
  }
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

    // Keep center video interaction alive; only top/bottom wake strips activate.
    frame.style.pointerEvents="auto";
    if(wakeTop) wakeTop.classList.add("active");
    if(wakeBottom) wakeBottom.classList.add("active");
    if(wakeLeft) wakeLeft.classList.add("active");
    if(wakeRight) wakeRight.classList.add("active");
  }
  function showOverlay(){
    topGradient.classList.remove("overlay-hidden");
    titleEl.classList.remove("overlay-hidden");
    qualityBtn.classList.remove("overlay-button-hidden");
    notPlayingBtn.classList.remove("overlay-button-hidden");

    frame.style.pointerEvents="auto";
    if(wakeTop) wakeTop.classList.remove("active");
    if(wakeBottom) wakeBottom.classList.remove("active");
    if(wakeLeft) wakeLeft.classList.remove("active");
    if(wakeRight) wakeRight.classList.remove("active");

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
    var out=[], seen={};

    function add(name,url){
      url=clean(url);
      if(!validStreamUrl(url) || seen[url]) return;
      seen[url]=true;
      out.push({name:name,url:url});
    }

    /*
     * Do not trust only list[0].
     * Some upstream responses can contain a dead first item and a usable
     * fallback item later in the list.
     */
    list.forEach(function(item){
      item=item||{};
      var fast=item.fast_stream_url||{};
      ["1080p","720p","480p","360p","240p"].forEach(function(name){
        add(name,fast[name]);
      });
      add("Auto",item.stream_url);
    });

    return out;
  }

  function startupCandidates(items){
    var priority={"480p":0,"360p":1,"Auto":2,"720p":3,"1080p":4,"240p":5};

    return (items||[]).slice().sort(function(a,b){
      var pa=Object.prototype.hasOwnProperty.call(priority,a.name)?priority[a.name]:99;
      var pb=Object.prototype.hasOwnProperty.call(priority,b.name)?priority[b.name]:99;
      return pa-pb;
    });
  }

  function createPlayerError(message,code,step){
    var error=new Error(message);
    error.diagnosticCode=code;
    error.diagnosticStep=step;
    return error;
  }

  function shouldProbe(items){
    return Array.isArray(items) && items.length>0;
  }

  function probeOne(item,generation,timeoutMs){
    return new Promise(function(resolve){
      if(generation!==probeGeneration){resolve(null);return;}

      var done=false;
      var v=document.createElement("video");
      v.className="probe-video";
      v.preload="metadata";
      v.muted=true;
      v.playsInline=true;
      document.body.appendChild(v);

      function finish(ok){
        if(done) return;
        done=true;
        clearTimeout(timer);
        try{
          v.pause();
          v.removeAttribute("src");
          v.load();
          v.remove();
        }catch(e){}
        resolve(ok?item:null);
      }

      var timer=setTimeout(function(){
        var d=v.duration;
        finish(
          v.readyState>=1 &&
          ((isFinite(d)&&d>0)||d===Infinity||v.videoWidth>0)
        );
      },timeoutMs || Number(cfg.probeTimeoutMs) || 2500);

      v.onerror=function(){finish(false);};
      v.onloadedmetadata=function(){
        var d=v.duration;
        if((isFinite(d)&&d>0)||d===Infinity||v.videoWidth>0) finish(true);
      };
      v.oncanplay=function(){
        var d=v.duration;
        if((isFinite(d)&&d>0)||d===Infinity||v.videoWidth>0||v.readyState>=3) finish(true);
      };

      try{
        v.src=item.url;
        v.load();
      }catch(e){
        finish(false);
      }
    });
  }

  async function findFirstPlayable(items,generation){
    if(!shouldProbe(items)) return null;

    /*
     * Try the reliable 480p/360p/Auto order first. The first candidate is
     * checked alone for fast start; fallbacks use at most two parallel probes.
     */
    var timeout=Number(cfg.probeTimeoutMs)||4000;
    var first=await probeOne(items[0],generation,timeout);
    if(first) return first;

    var concurrency=Math.max(1,Math.min(Number(cfg.startupProbeConcurrency)||2,2));
    for(var i=1;i<items.length;i+=concurrency){
      if(generation!==probeGeneration) return null;

      var batch=items.slice(i,i+concurrency);
      var results=await Promise.all(batch.map(function(item){
        return probeOne(item,generation,timeout);
      }));

      for(var j=0;j<results.length;j++){
        if(results[j]) return results[j];
      }
    }
    return null;
  }

  async function validateRemainingInBackground(items,firstPlayable,generation){
    var remaining=items.filter(function(item){
      return !firstPlayable || item.url!==firstPlayable.url;
    });

    var playable=firstPlayable?[firstPlayable]:[];
    var order={};
    items.forEach(function(item,index){order[item.url]=index;});

    function publishPlayable(){
      if(generation!==probeGeneration) return;

      var currentUrl="";
      if(selectedIndex>=0 && selectedIndex<good.length){
        currentUrl=good[selectedIndex].url||"";
      }

      good=playable.slice().sort(function(a,b){
        return order[a.url]-order[b.url];
      });
      refreshQualityMenu();

      if(currentUrl){
        for(var index=0;index<good.length;index++){
          if(good[index].url===currentUrl){
            selectedIndex=index;
            qualityBtn.textContent="Quality: "+good[index].name;
            break;
          }
        }
      }
    }

    if(!remaining.length){
      publishPlayable();
      return;
    }

    /* Give the selected video priority before validating optional qualities. */
    await sleep(Number(cfg.backgroundProbeDelayMs)||450);

    /* Sequential checks avoid a burst of media requests on every device. */
    for(var i=0;i<remaining.length;i++){
      if(generation!==probeGeneration || document.hidden) return;

      var result=await probeOne(
        remaining[i],
        generation,
        Number(cfg.backgroundProbeTimeoutMs)||5000
      );

      if(result){
        playable.push(result);
        publishPlayable();
      }

      if(i<remaining.length-1) await sleep(120);
    }
  }

  function sleep(ms){
    return new Promise(function(resolve){setTimeout(resolve,ms);});
  }

  function createRequestId(){
    return "web-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,10);
  }

  async function apiRequestOnce(forceRefresh){
    if(typeof navigator!=="undefined" && navigator.onLine===false){
      var offline=new Error("No internet connection.");
      offline.code="OFFLINE";
      throw offline;
    }

    var controller=new AbortController();
    var timer=setTimeout(function(){controller.abort();},Number(cfg.requestTimeoutMs)||25000);
    var requestId=createRequestId();

    try{
      var response=await fetch(cfg.streamApi,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          url:source,
          forceRefresh:forceRefresh===true,
          requestId:requestId
        }),
        signal:controller.signal,
        credentials:"omit",
        cache:"no-store"
      });

      lastCacheState=clean(response.headers.get("x-bidamax-cache"));
      lastGenerationState=clean(response.headers.get("x-bidamax-generation"));
      lastRequestId=clean(response.headers.get("x-bidamax-request-id"))||requestId;

      var bodyText=await response.text();
      var data={};
      try{
        data=bodyText?JSON.parse(bodyText):{};
      }catch(e){
        var bad=new Error("Invalid server response");
        bad.status=response.status;
        throw bad;
      }


      if(!response.ok){
        var err=new Error(data.message || data.error || ("Server error "+response.status));
        err.status=response.status;
        throw err;
      }

      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiRequest(forceRefresh){
    var lastErr=null;

    /*
     * One lightweight retry for temporary network/server pressure only.
     * Never loop requests indefinitely because that can increase upstream/API load.
     */
    for(var attempt=0;attempt<2;attempt++){
      try{
        return await apiRequestOnce(forceRefresh || attempt>0);
      }catch(err){
        lastErr=err;
        var status=Number(err && err.status)||0;
        var retryable=
          (!err || err.code!=="OFFLINE") &&
          (
            (err && err.name==="AbortError") ||
            status===0 ||
            status===408 ||
            status===425 ||
            status===429 ||
            status===502 ||
            status===503 ||
            status===504
          );

        if(!retryable || attempt===1) throw err;
        await sleep(550+Math.floor(Math.random()*200));
      }
    }

    throw lastErr || new Error("Unable to contact player server.");
  }

  async function loadTerabox(){
    if(loadingRequest) return;

    loadingRequest=true;
    var loadToken=++activeLoadToken;
    showLoading();
    errorBox.hidden=true;
    qualityPanel.style.display="none";
    qualityBtn.hidden=true;
    good=[];
    candidates=[];
    selectedIndex=-1;
    frame.src="about:blank";

    try{
      var maxGenerationAttempts=Math.max(
        1,
        Math.min(Number(cfg.maxGenerationAttempts)||2,2)
      );
      var firstPlayable=null;
      var generation=0;
      var generationError=null;

      /*
       * Regenerate only once when a successful API response contains empty or
       * dead temporary URLs. The hard limit prevents request loops and abuse.
       */
      for(var generationAttempt=0;generationAttempt<maxGenerationAttempts;generationAttempt++){
        if(generationAttempt>0){
          await sleep(Number(cfg.generationRetryDelayMs)||500);
        }

        if(loadToken!==activeLoadToken) return;

        var data=await apiRequest(generationAttempt>0);
        if(loadToken!==activeLoadToken) return;

        candidates=parseCandidates(data);
        if(!candidates.length){
          generationError=createPlayerError(
            "No playable stream was generated.",
            "NO_STREAM",
            "parse_candidates"
          );
          continue;
        }

        generation=++probeGeneration;
        firstPlayable=await findFirstPlayable(
          startupCandidates(candidates),
          generation
        );

        if(loadToken!==activeLoadToken || generation!==probeGeneration) return;
        if(firstPlayable) break;

        generationError=createPlayerError(
          "The generated stream could not be opened.",
          "PROBE_FAIL",
          "stream_probe"
        );
      }

      if(!firstPlayable){
        throw generationError || createPlayerError(
          "The generated stream could not be opened.",
          "PROBE_FAIL",
          "stream_probe"
        );
      }

      /*
       * FAST START:
       * only one confirmed working stream is needed to start playback.
       * Remaining qualities are validated in the background.
       */
      good=[firstPlayable];
      refreshQualityMenu();
      changeQuality(0);

      validateRemainingInBackground(
        candidates,
        firstPlayable,
        generation
      ).catch(function(err){
        console.warn("[BidamaxV2] background probe failed",err);
      });

    }catch(err){
      console.warn("[BidamaxV2] player error",{
        message:err && err.message,
        status:err && err.status,
      });

      var msg="Unable to load stream.";
      var diagnosticCode=err && err.diagnosticCode || "PLAYER_ERROR";
      var diagnosticStep=err && err.diagnosticStep || "terabox";

      if(err && err.code==="OFFLINE"){
        diagnosticCode="OFFLINE";
        diagnosticStep="network";
        msg="No internet connection. Reconnect and try again.";
      }else if(err && err.name==="AbortError"){
        diagnosticCode="API_TIMEOUT";
        diagnosticStep="api_request";
        msg="The player server is taking too long. Please try again.";
      }else if(err && Number(err.status)===429){
        diagnosticCode="RATE_LIMIT";
        diagnosticStep="api_request";
        msg="The player is busy right now. Please try again shortly.";
      }else if(err && (Number(err.status)===502 || Number(err.status)===503 || Number(err.status)===504)){
        diagnosticCode="UPSTREAM_5XX";
        diagnosticStep="api_request";
        msg="The video service is temporarily unavailable. Please try again.";
      }else if(err && (Number(err.status)===401 || Number(err.status)===403)){
        diagnosticCode="AUTH_FAIL";
        diagnosticStep="api_request";
        msg="The player service could not authorize this request.";
      }else if(err && /no playable stream/i.test(err.message||"")){
        diagnosticCode="NO_STREAM";
        diagnosticStep="parse_candidates";
        msg=err.message;
      }else if(err && /generated stream could not be opened|temporarily unavailable/i.test(err.message||"")){
        diagnosticCode="PROBE_FAIL";
        diagnosticStep="stream_probe";
        msg=err.message;
      }else if(err && /invalid server response/i.test(err.message||"")){
        diagnosticCode="BAD_API_RESPONSE";
        diagnosticStep="api_parse";
        msg=err.message;
      }else if(err && err.message){
        msg=err.message;
      }

      reportDiagnostic(diagnosticCode,{
        step:diagnosticStep,
        status:Number(err && err.status)||0,
        message:err && err.message,
        cacheState:lastCacheState,
        generationState:lastGenerationState,
        requestId:lastRequestId
      });

      showError(msg);
    }finally{
      if(loadToken===activeLoadToken) loadingRequest=false;
    }
  }

  function loadDirect(){
    var direct=normalizeDirect(source);
    if(!/^https?:\/\//i.test(direct)){
      reportDiagnostic("INVALID_SOURCE",{step:"direct_route",message:"Invalid video link"});
      showError("Invalid video link.");
      return;
    }
    qualityBtn.hidden=true;
    frame.src=direct;
    hideLoading();
    showOverlay();
  }
  function manualRecovery(){
    var now=Date.now();

    /*
     * Prevent rapid repeated "Not Playing?" taps from generating too many
     * fresh upstream requests.
     */
    if(now<recoveryLockedUntil) return;
    recoveryLockedUntil=now+2500;

    if(isTerabox(source)){
      loadingRequest=false;
      ++activeLoadToken;
      ++probeGeneration;
      loadTerabox();
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
  retryBtn.addEventListener("click",function(e){
    e.stopPropagation();
    var now=Date.now();
    if(now<recoveryLockedUntil) return;
    recoveryLockedUntil=now+2500;

    if(isTerabox(source)){
      loadingRequest=false;
      ++activeLoadToken;
      ++probeGeneration;
      loadTerabox();
    }else{
      loadDirect();
    }
  });
  function wakeControlsFromZone(e){
    if(e){
      e.preventDefault();
      e.stopPropagation();
    }
    showOverlay();
  }

  if(wakeTop){
    wakeTop.addEventListener("click", wakeControlsFromZone);
  }
  if(wakeBottom){
    wakeBottom.addEventListener("click", wakeControlsFromZone);
  }
  if(wakeLeft){
    wakeLeft.addEventListener("click", wakeControlsFromZone);
  }
  if(wakeRight){
    wakeRight.addEventListener("click", wakeControlsFromZone);
  }

  document.getElementById("player").addEventListener("click",function(e){
    if(e.target===qualityBtn || e.target===notPlayingBtn || qualityPanel.contains(e.target) || e.target===retryBtn) return;
    toggleOverlay();
  });
  document.addEventListener("visibilitychange",function(){if(!document.hidden)showOverlay();});
  window.addEventListener("online",function(){
    if(isTerabox(source) && !errorBox.hidden){
      setTimeout(manualRecovery,250);
    }
  });

  source=clean(q("src"));
  title=clean(q("title")) || "Now Playing";
  titleEl.textContent=title;

  if(!source || source.toLowerCase()==="n/a"){
    reportDiagnostic("NO_SOURCE",{step:"startup",message:"No video link was provided"});
    showError("No video link was provided.");
  }
  else if(isTerabox(source)) loadTerabox();
  else loadDirect();
})();
