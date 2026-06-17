(function(){
  function callGas(functionName, args, onSuccess, onFailure){
    fetch("/api/gas/" + encodeURIComponent(functionName), {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({args:Array.from(args || [])})
    })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || ("API local HTTP " + response.status));
        }
        return payload.result;
      })
      .then(result => {
        if (typeof onSuccess === "function") onSuccess(result);
      })
      .catch(error => {
        if (typeof onFailure === "function") onFailure(error);
        else console.error("[GAS_BRIDGE_ERROR]", functionName, error);
      });
  }

  function makeRunner(onSuccess, onFailure){
    const base = {
      withSuccessHandler(handler){ return makeRunner(handler, onFailure); },
      withFailureHandler(handler){ return makeRunner(onSuccess, handler); }
    };
    return new Proxy(base, {
      get(target, property){
        if (property in target) return target[property];
        return function(){
          callGas(String(property), arguments, onSuccess, onFailure);
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();
