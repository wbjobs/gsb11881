const PHYSICS_UNIFORMS = `
uniform float uGravity;
uniform float uWind;
uniform float uAttractorStrength;
uniform float uAttractorEnabled;
uniform vec2 uAttractor;
uniform float uDt;
`;

const PHYSICS_FUNCTIONS = `
vec2 accelerationAt(vec2 position) {
  vec2 direction = uAttractor - position;
  float distanceSquared = dot(direction, direction) + 0.0025;
  direction *= inversesqrt(distanceSquared);
  float attractor = uAttractorEnabled * uAttractorStrength;
  return vec2(
    uWind + attractor * direction.x,
    uGravity + attractor * direction.y
  );
}

vec2 advanceVelocity(vec2 position, vec2 velocity) {
  vec2 nextVelocity = (velocity + accelerationAt(position) * uDt) * 0.999;
  vec2 nextPosition = position + nextVelocity * uDt;

  if (nextPosition.x < -1.0 || nextPosition.x > 1.0) {
    nextVelocity.x *= -0.82;
  }
  if (nextPosition.y < -1.0 || nextPosition.y > 1.0) {
    nextVelocity.y *= -0.82;
  }

  return nextVelocity;
}

vec2 advancePosition(vec2 position, vec2 velocity) {
  return clamp(position + velocity * uDt, vec2(-1.0), vec2(1.0));
}
`;

export const TRANSFORM_VERTEX_SHADER = `
attribute vec2 aPosition;
attribute vec2 aVelocity;
varying vec2 vPosition;
varying vec2 vVelocity;
${PHYSICS_UNIFORMS}
${PHYSICS_FUNCTIONS}

void main() {
  vec2 nextVelocity = advanceVelocity(aPosition, aVelocity);
  vPosition = advancePosition(aPosition, nextVelocity);
  vVelocity = nextVelocity;
  gl_Position = vec4(vPosition, 0.0, 1.0);
}
`;

const RENDER_VERTEX_SHADER = `
attribute vec2 aPosition;
attribute vec2 aVelocity;
uniform float uPointSize;
varying vec2 vVelocity;

void main() {
  vVelocity = aVelocity;
  gl_Position = vec4(aPosition, 0.0, 1.0);
  gl_PointSize = uPointSize;
}
`;

const TEXTURE_RENDER_VERTEX_SHADER = `
attribute float aIndex;
uniform sampler2D uState;
uniform vec2 uTextureSize;
uniform float uPointSize;
varying vec2 vVelocity;

void main() {
  float indexX = mod(aIndex, uTextureSize.x);
  float indexY = floor(aIndex / uTextureSize.x);
  vec2 texel = vec2(indexX, indexY) + 0.5;
  vec2 uv = texel / uTextureSize;
  vec4 state = texture2D(uState, uv);
  vec2 position = state.xy;
  vVelocity = state.zw;
  gl_Position = vec4(position, 0.0, 1.0);
  gl_PointSize = uPointSize;
}
`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vVelocity;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  if (dot(point, point) > 1.0) discard;
  float speed = clamp(length(vVelocity) * 2.5, 0.0, 1.0);
  vec3 slow = vec3(0.18, 0.55, 1.0);
  vec3 fast = vec3(1.0, 0.58, 0.18);
  vec4 color = vec4(mix(slow, fast, speed), 0.58);
  gl_FragColor = color;
}
`;

const FULLSCREEN_VERTEX_SHADER = `
attribute vec2 aCorner;
varying vec2 vUv;

void main() {
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}
`;

const PACKED_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D uState;
varying vec2 vUv;
${PHYSICS_UNIFORMS}
${PHYSICS_FUNCTIONS}

void main() {
  vec4 state = texture2D(uState, vUv);
  vec2 position = state.xy;
  vec2 velocity = state.zw;
  vec2 nextVelocity = advanceVelocity(position, velocity);
  vec2 nextPosition = advancePosition(position, nextVelocity);
  gl_FragColor = vec4(nextPosition, nextVelocity);
}
`;

export const SHADERS = Object.freeze({
  renderVertex: RENDER_VERTEX_SHADER,
  textureRenderVertex: TEXTURE_RENDER_VERTEX_SHADER,
  fragment: FRAGMENT_SHADER,
  fullscreenVertex: FULLSCREEN_VERTEX_SHADER,
  packedFragment: PACKED_FRAGMENT_SHADER
});

export const PHYSICS_UNIFORM_NAMES = Object.freeze([
  'uGravity',
  'uWind',
  'uAttractorStrength',
  'uAttractorEnabled',
  'uAttractor',
  'uDt'
]);
