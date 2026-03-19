"use strict";

(function () {

	function Start()
	{
		// Save the runtime reference so multiplayer.js can read rocket positions
		var result = window.cr_createRuntime({
			exportType: "html5"
		});
		if (result) window._rpRuntime = result;

		// Fallback: scan window for the runtime object after the engine has started
		setTimeout(function () {
			if (window._rpRuntime) return;
			try {
				var keys = Object.getOwnPropertyNames(window);
				for (var i = 0; i < keys.length; i++) {
					try {
						var v = window[keys[i]];
						if (v && typeof v === 'object' &&
							v.types && v.running_layout &&
							typeof v.tickcount === 'number') {
							window._rpRuntime = v;
							break;
						}
					} catch (e) {}
				}
			} catch (e) {}
		}, 2500);
	};

	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", Start);
	else
		Start();

})();
