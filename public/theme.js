/* NearBeam theme bootstrap.
 * Applied as a synchronous same-origin classic script so the stored (or
 * system-preferred) theme is set before first paint, without needing
 * 'unsafe-inline' in the Content-Security-Policy.
 */
;(function () {
  try {
    var stored = localStorage.getItem('nearbeam:theme')
    var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches
    var theme = stored === 'light' || stored === 'dark' ? stored : prefersLight ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#070b14' : '#f4f7fc')
  } catch {
    /* private mode or blocked storage: the default dark theme stands */
  }
})()
