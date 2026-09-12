// p5.brush 2.2.2 composites pigments against opaque white paper. Canvas layers need premultiplied alpha.
(() => {
  const pigmentShaders = new WeakSet(), compositorPrograms = new WeakSet();
  const background = /vec3 bgColor\s*=[^;]+;/;
  const output = /outColor\s*=\s*vec4\(spectral_mix\(bgColor,\s*pigment.rgb,\s*mixIntensity\),\s*1\.\);/;
  globalThis.canvasPigmentAlphaReady = false;
  const gl = WebGL2RenderingContext.prototype;
  const shaderSource = gl.shaderSource;
  gl.shaderSource = function(shader, source) {
    if (source.includes('vec3 bgColor')) {
      if (!background.test(source) || !output.test(source)) throw new Error('Unsupported p5.brush pigment shader');
      source = source.replace(background, `
        float coverage = clamp(mixIntensity, 0.0, 1.0);
        float alpha = coverage + source.a * (1.0 - coverage);
        vec3 bgColor = source.a > 0.0001 ? source.rgb / source.a : pigment.rgb;
      `).replace(output, `
        vec3 mixed = spectral_mix(bgColor, pigment.rgb, coverage);
        vec3 rgb = mix(pigment.rgb, mixed, source.a);
        outColor = vec4(rgb * alpha, alpha);
      `);
      pigmentShaders.add(shader);
      globalThis.canvasPigmentAlphaReady = true;
    }
    return shaderSource.call(this, shader, source);
  };
  const attachShader = gl.attachShader;
  gl.attachShader = function(program, shader) {
    if (pigmentShaders.has(shader)) compositorPrograms.add(program);
    return attachShader.call(this, program, shader);
  };
  const drawArrays = gl.drawArrays;
  gl.drawArrays = function(...args) {
    // The shader already includes the destination; blending it again would apply its alpha twice.
    const blending = compositorPrograms.has(this.getParameter(this.CURRENT_PROGRAM)) && this.isEnabled(this.BLEND);
    if (blending) this.disable(this.BLEND);
    drawArrays.apply(this, args);
    if (blending) this.enable(this.BLEND);
  };
})();
