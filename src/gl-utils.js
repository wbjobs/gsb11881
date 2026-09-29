import { GpuCapabilityError } from './errors.js';

const POSITION_LOCATION = 0;
const VELOCITY_LOCATION = 1;

const COMPUTE_VERTEX_SOURCE = `#version 300 es
#define MAX_ATTRACTORS 4
precision highp float;

in vec2 a_position;
in vec2 a_velocity;

uniform vec2 u_gravity;
uniform vec2 u_wind;
uniform vec2 u_boundsMin;
uniform vec2 u_boundsMax;
uniform vec4 u_attractors[MAX_ATTRACTORS];
uniform float u_dt;
uniform float u_restitution;
uniform float u_dragFactor;

out vec2 v_position;
out vec2 v_velocity;

void main() {
  vec2 nextPosition = a_position;
  vec2 nextVelocity = a_velocity;
  vec2 acceleration = u_gravity + u_wind;

  for (int index = 0; index < MAX_ATTRACTORS; index++) {
    vec4 attractor = u_attractors[index];
    if (attractor.w > 0.5) {
      vec2 delta = attractor.xy - nextPosition;
      float distance = length(delta) + 0.001;
      float force = attractor.z / (distance * (distance * distance + 100.0));
      acceleration += delta * force;
    }
  }

  nextVelocity = (nextVelocity + acceleration * u_dt) * u_dragFactor;
  nextPosition += nextVelocity * u_dt;

  if (nextPosition.x < u_boundsMin.x) {
    nextPosition.x = u_boundsMin.x;
    if (nextVelocity.x < 0.0) nextVelocity.x = -nextVelocity.x * u_restitution;
  } else if (nextPosition.x > u_boundsMax.x) {
    nextPosition.x = u_boundsMax.x;
    if (nextVelocity.x > 0.0) nextVelocity.x = -nextVelocity.x * u_restitution;
  }

  if (nextPosition.y < u_boundsMin.y) {
    nextPosition.y = u_boundsMin.y;
    if (nextVelocity.y < 0.0) nextVelocity.y = -nextVelocity.y * u_restitution;
  } else if (nextPosition.y > u_boundsMax.y) {
    nextPosition.y = u_boundsMax.y;
    if (nextVelocity.y > 0.0) nextVelocity.y = -nextVelocity.y * u_restitution;
  }

  v_position = nextPosition;
  v_velocity = nextVelocity;
}
`;

const COMPUTE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0);
}
`;

const RENDER_VERTEX_SOURCE = `#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_velocity;

uniform vec2 u_boundsMin;
uniform vec2 u_boundsMax;
uniform float u_pointSize;

out float v_speed;

void main() {
  vec2 size = u_boundsMax - u_boundsMin;
  vec2 normalized = (a_position - u_boundsMin) / size;
  gl_Position = vec4(normalized * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = u_pointSize;
  v_speed = clamp(length(a_velocity) / 32.0, 0.0, 1.0);
}
`;

const RENDER_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in float v_speed;
out vec4 outColor;

void main() {
  vec2 point = gl_PointCoord - vec2(0.5);
  float distanceSquared = dot(point, point);
  if (distanceSquared > 0.25) discard;
  vec3 cold = vec3(0.16, 0.55, 1.0);
  vec3 hot = vec3(1.0, 0.72, 0.12);
  outColor = vec4(mix(cold, hot, v_speed), 0.82);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new GpuCapabilityError(`Shader compilation failed: ${message}`, 'shader-compile');
  }

  return shader;
}

export function createProgram(gl, vertexSource, fragmentSource, transformFeedbackVaryings = null) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, POSITION_LOCATION, 'a_position');
  gl.bindAttribLocation(program, VELOCITY_LOCATION, 'a_velocity');
  if (transformFeedbackVaryings) {
    gl.transformFeedbackVaryings(program, transformFeedbackVaryings, gl.SEPARATE_ATTRIBS);
  }
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new GpuCapabilityError(`Program link failed: ${message}`, 'program-link');
  }

  return program;
}

export function createTransformProgram(gl) {
  return createProgram(gl, COMPUTE_VERTEX_SOURCE, COMPUTE_FRAGMENT_SOURCE, ['v_position', 'v_velocity']);
}

export function createRenderProgram(gl) {
  return createProgram(gl, RENDER_VERTEX_SOURCE, RENDER_FRAGMENT_SOURCE);
}

export function getUniforms(gl, program, names) {
  const uniforms = {};
  for (const name of names) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return uniforms;
}

export function attributeLocations() {
  return {
    position: POSITION_LOCATION,
    velocity: VELOCITY_LOCATION
  };
}

export function getGlErrorLabel(gl) {
  const error = gl.getError();
  if (error === gl.NO_ERROR) return null;
  switch (error) {
    case gl.OUT_OF_MEMORY:
      return 'OUT_OF_MEMORY';
    case gl.INVALID_OPERATION:
      return 'INVALID_OPERATION';
    case gl.INVALID_VALUE:
      return 'INVALID_VALUE';
    default:
      return `GL_ERROR_${error}`;
  }
}
