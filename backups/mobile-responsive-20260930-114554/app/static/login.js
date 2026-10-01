
// Sign-in page motion: a WebGL "liquid" background in the brand greens and a headline that rises letter by
// letter (the apple itself stays still). Everything is optional — without WebGL the CSS gradient behind the
// canvas shows, and with reduced motion the page is drawn once and holds still.
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Pointer position, used by the shader. Starts off-centre so
  // the first frame already has some light in it.
  var ptr = { x: window.innerWidth * 0.3, y: window.innerHeight * 0.4 };
  var smooth = { x: ptr.x, y: ptr.y };
  window.addEventListener('pointermove', function (e) { ptr.x = e.clientX; ptr.y = e.clientY; }, { passive: true });

  // ---------------------------------------------------------- card logo
  var cardLogo = document.querySelector('.gate-card .logo');
  if (cardLogo && !reduce) cardLogo.classList.add('intro');   // wordmark wipe only; the apple stays still

  // ------------------------------------------------------ headline split
  var head = document.getElementById('headline');
  if (head && !reduce) {
    var n = 0;
    head.querySelectorAll('.line').forEach(function (line) {
      var text = line.textContent.trim();
      line.textContent = '';
      Array.prototype.forEach.call(text, function (c) {
        var s = document.createElement('span');
        s.className = 'ch';
        s.textContent = c;
        s.style.setProperty('--i', n++);
        line.appendChild(s);
      });
    });
    head.classList.add('split');
  }

  // ------------------------------------------------------ submit state
  var form = document.getElementById('gate-form'), go = document.getElementById('go');
  if (form && go) {
    form.addEventListener('submit', function () {
      go.classList.add('busy');
      go.querySelector('span').textContent = 'Checking…';
      go.querySelector('svg').innerHTML = '<path d="M12 3a9 9 0 1 0 9 9"></path>';
    });
  }

  // ------------------------------------------------------ WebGL backdrop
  var canvas = document.getElementById('gl');
  var gl = canvas && (canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }) ||
                      canvas.getContext('experimental-webgl'));
  var draw = null;

  if (gl) {
    var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    // Domain-warped fractal noise: layers of noise feeding each other's
    // coordinates, which gives the slow, folding "liquid" look.
    var FS = [
      'precision mediump float;',
      'uniform vec2 u_res; uniform float u_t; uniform vec2 u_m;',
      'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
      'float nz(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);',
      '  return mix(mix(h(i),h(i+vec2(1.,0.)),u.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),u.x),u.y);}',
      'float fbm(vec2 p){float v=0.,a=.5;mat2 r=mat2(.8,.6,-.6,.8);',
      '  for(int i=0;i<5;i++){v+=a*nz(p);p=r*p*2.02;a*=.5;}return v;}',
      'void main(){',
      '  float s=min(u_res.x,u_res.y);',
      '  vec2 uv=(gl_FragCoord.xy-.5*u_res)/s;',
      '  vec2 m=(u_m-.5*u_res)/s;',
      '  float t=u_t*.05;',
      '  vec2 q=vec2(fbm(uv*1.2+vec2(0.,t)),fbm(uv*1.2+vec2(5.2,1.3)-t));',
      '  vec2 r=vec2(fbm(uv*1.5+2.2*q+vec2(1.7,9.2)+t*.7+m*.3),fbm(uv*1.5+2.2*q+vec2(8.3,2.8)-t*.5));',
      '  float f=fbm(uv*1.4+2.4*r);',
      '  vec3 c=mix(vec3(.010,.035,.020),vec3(.028,.20,.095),smoothstep(.2,.8,f));',        // deep → forest
      '  c=mix(c,vec3(.047,.52,.227),smoothstep(.55,.95,f*f*1.6+r.x*.2));',                  // brand green
      '  c+=vec3(.24,.77,.43)*pow(smoothstep(.6,1.,f),3.)*.5;',                               // highlight
      '  c=mix(c,vec3(.83,.04,.09),smoothstep(.62,.9,r.y)*smoothstep(.45,.9,q.x)*.32);',       // red ember
      '  c+=vec3(.10,.45,.22)*exp(-3.*length(uv-m))*.35;',                                    // pointer glow
      '  c*=1.-.5*dot(uv*.9,uv*.9);',                                                         // vignette
      '  c+=(h(gl_FragCoord.xy+fract(u_t))-.5)*.03;',                                         // film grain
      '  gl_FragColor=vec4(c,1.);',
      '}'
    ].join('\n');

    var sh = function (type, src) {
      var o = gl.createShader(type);
      gl.shaderSource(o, src); gl.compileShader(o);
      return gl.getShaderParameter(o, gl.COMPILE_STATUS) ? o : null;
    };
    var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    var prog = vs && fs && gl.createProgram();
    if (prog) {
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) prog = null;
    }

    if (prog) {
      gl.useProgram(prog);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      var uRes = gl.getUniformLocation(prog, 'u_res');
      var uT = gl.getUniformLocation(prog, 'u_t');
      var uM = gl.getUniformLocation(prog, 'u_m');

      // Rendered at reduced resolution and scaled up: the image is soft by
      // nature, and this keeps it smooth on ordinary office laptops.
      var SCALE = 0.5, W = 0, H = 0;
      var resize = function () {
        W = Math.max(1, Math.round(window.innerWidth * SCALE));
        H = Math.max(1, Math.round(window.innerHeight * SCALE));
        canvas.width = W; canvas.height = H;
        gl.viewport(0, 0, W, H);
      };
      window.addEventListener('resize', function () { resize(); if (reduce && draw) draw(0); });
      resize();

      var t0 = performance.now();
      draw = function (now) {
        gl.uniform2f(uRes, W, H);
        gl.uniform1f(uT, reduce ? 20 : (now - t0) / 1000 + 20);
        gl.uniform2f(uM, smooth.x * SCALE, H - smooth.y * SCALE);   // GL's y axis points up
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      draw(t0);
      requestAnimationFrame(function () { canvas.classList.add('on'); });
    }
  }

  if (reduce) return;

  // ------------------------------------------------------ frame loop
  function loop(now) {
    // Ease toward the pointer so motion feels weighted rather than twitchy.
    smooth.x += (ptr.x - smooth.x) * 0.06;
    smooth.y += (ptr.y - smooth.y) * 0.06;
    if (draw) draw(now);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
