(function(){
  "use strict";

  var cfg = window.BIDAMAX_PLAYER_CONFIG || {};
  var frame = document.getElementById("playerFrame");
  var titleEl = document.getElementById("movieTitle");
  var loading = document.getElementById("loading");
  var progressRing = document.getElementById("progressRing");
  var progressCircle = document.getElementById("progressCircle");
  var progressPercent = document.getElementById("progressPercent");
  var loadingText = document.getElementById("loadingText");
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
  var progressTimer = null;
  var displayedProgress = 0;
  var progressPhaseStart = 0;
  var progressPhaseCeiling = 0;
  var progressPhaseStartedAt = 0;
  var progressPhaseDuration = 5200;

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
  function clampProgress(value){
    return Math.max(0,Math.min(100,Math.round(Number(value)||0)));
  }

  function setLoadingProgress(value,label,allowReset){
    value=clampProgress(value);
    if(!allowReset && value<displayedProgress) value=displayedProgress;
    displayedProgress=value;

    if(progressCircle){
      progressCircle.style.strokeDashoffset=String(100-value);
    }
    if(progressPercent){
      progressPercent.textContent=value+"%";
    }
    if(progressRing){
      progressRing.setAttribute("aria-valuenow",String(value));
    }
    if(loadingText){
      loadingText.textContent="Please wait...";
    }
  }

  function clearProgressTimer(){
    if(progressTimer){
      clearInterval(progressTimer);
      progressTimer=null;
    }
  }

  function tickLoadingProgress(){
    if(loading.hidden || progressPhaseCeiling<=displayedProgress) return;

    var elapsed=Math.max(0,Date.now()-progressPhaseStartedAt);
    var duration=Math.max(800,progressPhaseDuration);
    var linear=Math.min(1,elapsed/duration);
    var ratio=1-Math.pow(1-linear,3);
    var next=progressPhaseStart+((progressPhaseCeiling-progressPhaseStart)*ratio);

    if(next>=displayedProgress+0.6){
      setLoadingProgress(Math.min(progressPhaseCeiling,Math.floor(next)));
    }
  }

  function beginProgressPhase(minimum,ceiling,label,duration){
    setLoadingProgress(Math.max(displayedProgress,minimum),label);
    progressPhaseStart=displayedProgress;
    progressPhaseCeiling=Math.max(progressPhaseStart,clampProgress(ceiling));
    progressPhaseStartedAt=Date.now();
    progressPhaseDuration=Math.max(
      800,
      Number(duration)||Number(cfg.progressPhaseDurationMs)||4200
    );
  }

  function startLoadingProgress(){
    clearProgressTimer();
    displayedProgress=1;
    setLoadingProgress(1,"Please wait...",true);
    beginProgressPhase(
      1,
      94,
      "Please wait...",
      Number(cfg.progressPhaseDurationMs)||4200
    );
    progressTimer=setInterval(
      tickLoadingProgress,
      Math.max(16,Number(cfg.progressTickMs)||24)
    );
  }

  function completeLoadingProgress(loadToken){
    clearProgressTimer();

    var from=displayedProgress;
    var configuredDuration=Math.max(
      120,
      Number(cfg.progressCompletionDurationMs)||280
    );
    var duration=Math.max(
      120,
      Math.min(configuredDuration,(100-from)*4)
    );
    var startedAt=Date.now();

    return new Promise(function(resolve){
      function step(){
        if(loadToken!==activeLoadToken || loading.hidden){
          resolve(false);
          return;
        }

        var elapsed=Date.now()-startedAt;
        var ratio=Math.min(1,elapsed/duration);
        var value=from+((100-from)*ratio);
        setLoadingProgress(value,"Please wait...");

        if(ratio<1){
          setTimeout(step,16);
          return;
        }

        setLoadingProgress(100,"Please wait...");
        setTimeout(function(){
          resolve(loadToken===activeLoadToken && !loading.hidden);
        },Math.max(32,Number(cfg.progressCompletionHoldMs)||55));
      }

      step();
    });
  }

  function showLoading(){
    loading.hidden=false;
    errorBox.hidden=true;
    startLoadingProgress();
  }
  function hideLoading(){
    clearProgressTimer();
    loading.hidden=true;
  }
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
  function changeQuality(index,keepLoading){
    if(index<0 || index>=good.length) return;
    selectedIndex=index;
    frame.src=good[index].url;
    qualityBtn.textContent="Quality: "+good[index].name;
    qualityPanel.style.display="none";
    if(keepLoading!==true) hideLoading();
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

  async function findFirstPlayable(items,generation,checked){
    if(!shouldProbe(items)) return null;

    /*
     * Try the reliable 480p/360p/Auto order first. The first candidate is
     * checked alone for fast start; fallbacks use at most two parallel probes.
     */
    var timeout=Number(cfg.probeTimeoutMs)||4000;
    var first=await probeOne(items[0],generation,timeout);
    if(checked) checked[items[0].url]=true;
    if(first) return first;

    var concurrency=Math.max(1,Math.min(Number(cfg.startupProbeConcurrency)||2,2));
    for(var i=1;i<items.length;i+=concurrency){
      if(generation!==probeGeneration) return null;

      var batch=items.slice(i,i+concurrency);
      var results=await Promise.all(batch.map(function(item){
        return probeOne(item,generation,timeout);
      }));

      if(checked){
        batch.forEach(function(item,index){
          /* Successful extras are rechecked later so they reach the menu. */
          if(!results[index]) checked[item.url]=true;
        });
      }

      for(var j=0;j<results.length;j++){
        if(results[j]){
          if(checked) checked[results[j].url]=true;
          return results[j];
        }
      }
    }
    return null;
  }

  async function validateGeneratedCandidates(items,optimisticItem,generation,loadToken){
    var playable=[];
    var checked={};
    var order={};
    items.forEach(function(item,index){order[item.url]=index;});

    function isActive(){
      return generation===probeGeneration && loadToken===activeLoadToken;
    }

    function publishPlayable(switchToUrl){
      if(!isActive() || !playable.length) return;

      var currentUrl="";
      if(selectedIndex>=0 && selectedIndex<good.length){
        currentUrl=good[selectedIndex].url||"";
      }
      var targetUrl=switchToUrl || currentUrl || playable[0].url;

      good=playable.slice().sort(function(a,b){
        return order[a.url]-order[b.url];
      });
      refreshQualityMenu();

      var nextIndex=0;
      for(var index=0;index<good.length;index++){
        if(good[index].url===targetUrl){
          nextIndex=index;
          break;
        }
      }
      selectedIndex=nextIndex;
      qualityBtn.textContent="Quality: "+good[nextIndex].name;

      if(switchToUrl && frame.getAttribute("src")!==good[nextIndex].url){
        frame.src=good[nextIndex].url;
      }
    }

    /* Let the iframe begin loading before making any optional media request. */
    await sleep(Number(cfg.backgroundProbeDelayMs)||450);
    if(!isActive() || document.hidden) return;

    var primary=await probeOne(
      optimisticItem,
      generation,
      Number(cfg.probeTimeoutMs)||4000
    );
    checked[optimisticItem.url]=true;

    if(!isActive()) return;

    if(primary){
      playable.push(primary);
      publishPlayable();
    }else{
      var fallbackItems=items.filter(function(item){
        return item.url!==optimisticItem.url;
      });
      var fallback=await findFirstPlayable(
        fallbackItems,
        generation,
        checked
      );

      if(!isActive()) return;
      if(!fallback){
        throw createPlayerError(
          "The generated stream could not be opened.",
          "PROBE_FAIL",
          "stream_probe"
        );
      }

      playable.push(fallback);
      publishPlayable(fallback.url);
    }

    var remaining=items.filter(function(item){
      return !checked[item.url];
    });

    /* Validate optional qualities sequentially without delaying playback. */
    for(var i=0;i<remaining.length;i++){
      if(!isActive() || document.hidden) return;

      var result=await probeOne(
        remaining[i],
        generation,
        Number(cfg.backgroundProbeTimeoutMs)||5000
      );
      checked[remaining[i].url]=true;

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
        /* text/plain keeps this a simple CORS request and skips OPTIONS. */
        headers:{"Content-Type":"text/plain;charset=UTF-8"},
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

  async function apiRequest(forceRefresh,progressStage){
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
        beginProgressPhase(
          displayedProgress,
          Math.max(displayedProgress,progressStage.retryCeiling),
          "Please wait...",
          2600
        );
        await sleep(550+Math.floor(Math.random()*200));
      }
    }

    throw lastErr || new Error("Unable to contact player server.");
  }

  async function loadTerabox(options){
    if(loadingRequest) return;

    options=options||{};
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
      /* One successful API response is one accepted generation. */
      var maxGenerationAttempts=1;
      var generation=0;
      var generationError=null;

      /* A second generation is allowed only when the first response has no URL. */
      for(var generationAttempt=0;generationAttempt<maxGenerationAttempts;generationAttempt++){
        if(generationAttempt>0){
          await sleep(Number(cfg.generationRetryDelayMs)||500);
        }

        if(loadToken!==activeLoadToken) return;

        var progressStage=generationAttempt===0?{
          start:1,
          ceiling:94,
          retryCeiling:97
        }:{
          start:1,
          ceiling:99,
          retryCeiling:99
        };

        beginProgressPhase(
          progressStage.start,
          progressStage.ceiling,
          "Please wait...",
          Number(cfg.progressPhaseDurationMs)||4200
        );

        var data=await apiRequest(
          options.forceInitialRefresh===true || generationAttempt>0,
          progressStage
        );
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

        var orderedCandidates=startupCandidates(candidates);
        var optimisticItem=orderedCandidates[0];
        generation=++probeGeneration;

        /*
         * The generated URLs run inside an iframe. A separate hidden <video>
         * cannot reliably validate a cross-origin player URL and previously
         * caused false dead-link results while the iframe was already playing.
         * Accept every syntactically valid API candidate for this load.
         */
        good=orderedCandidates;
        refreshQualityMenu();
        /* Start the real iframe immediately while the visible ring finishes. */
        changeQuality(0,true);

        var completionShown=await completeLoadingProgress(loadToken);
        if(
          !completionShown ||
          loadToken!==activeLoadToken ||
          generation!==probeGeneration
        ) return;

        hideLoading();

        return;
      }

      throw generationError || createPlayerError(
        "No playable stream was generated.",
        "NO_STREAM",
        "parse_candidates"
      );

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
      loadTerabox({forceInitialRefresh:true});
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
      loadTerabox({forceInitialRefresh:true});
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
