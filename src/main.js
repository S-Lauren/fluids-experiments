import * as THREE from "three";
import { init } from "./init";

const sizes = {
  width: window.innerWidth,
  heigth: window.innerHeight,
};

const mouse = new THREE.Vector4(0, 0, 0, 0);
const prevMouse = new THREE.Vector4(0, 0, 0, 0);
window.addEventListener("mousemove", (e) => {
  prevMouse.copy(mouse);
  mouse.x = e.clientX / sizes.width;
  mouse.y = 1 - e.clientY / sizes.heigth;
  mouse.z = 1;
});

window.addEventListener("mouseleave", () => {
  prevMouse.copy(mouse);
  mouse.set(0, 0, 0, 0);
});

const scene = new THREE.Scene();
const planeGeo = new THREE.PlaneGeometry(2, 2);

// shaders.

const utils = `
#define dt .15
// lower value for vorticity threshold means higher viscosity
// and vice versa (max .3). Setting it to 0. disables it.
#define vorticityThreshold .25
#define velocityThreshold 24.
// higher this threshold, lower the viscosity (max .8)
#define viscosityThreshold .64

vec4 fluidSolver(sampler2D velocityField, vec2 uv, vec2 stepSize, vec4 mouse, vec4 prevMouse)
{
    float k = .2, s = k / dt;
    
    vec4 fluidData = textureLod(velocityField, uv, 0.);
    vec4 fr = textureLod(velocityField, uv + vec2(stepSize.x, 0.), 0.);
    vec4 fl = textureLod(velocityField, uv - vec2(stepSize.x, 0.), 0.);
    vec4 ft = textureLod(velocityField, uv + vec2(0., stepSize.y), 0.);
    vec4 fd = textureLod(velocityField, uv - vec2(0., stepSize.y), 0.);
    
    vec3 ddx = (fr - fl).xyz * .5;
    vec3 ddy = (ft - fd).xyz * .5;
    float divergence = ddx.x + ddy.y;
    vec2 densityDiff = vec2(ddx.z, ddy.z);
    
    // Solving for density
    fluidData.z -= dt*dot(vec3(densityDiff, divergence), fluidData.xyz);
    
    // Solving for velocity
    vec2 laplacian = fr.xy + fl.xy + ft.xy + fd.xy - 4.*fluidData.xy;
    vec2 viscosityForce = viscosityThreshold * laplacian;
    
    // Semi-lagrangian advection
    vec2 densityInvariance = s * densityDiff;
    vec2 uvHistory = uv - dt * fluidData.xy * stepSize;
    fluidData.xyw = texture2D(velocityField, uvHistory, 0.).xyw;
    
    // Calc external force from mouse input
    vec2 extForce = vec2(0.);
    
    if (mouse.w > 1. && prevMouse.z > 1.)
    {
        vec2 dragDir = clamp((mouse.xy - prevMouse.xy) * stepSize * 600., -10., 10.);
        vec2 p = uv - mouse.xy*stepSize;
        // extForce.xy += .0008 / (dot(p, p) + 1e-5) * (.5 - uv);
        extForce.xy += .001/(dot(p, p)) * dragDir;
    }
    
    fluidData.xy += dt*(viscosityForce - densityInvariance + extForce);
    
    // velocity decay
    fluidData.xy = max(vec2(0.), abs(fluidData.xy) - 5e-6)*sign(fluidData.xy);
    
    // Vorticity confinement
	fluidData.w = (fd.x - ft.x + fr.y - fl.y); // curl stored in the w channel
    vec2 vorticity = vec2(abs(ft.w) - abs(fd.w), abs(fl.w) - abs(fr.w));
    vorticity *= vorticityThreshold / (length(vorticity) + 1e-5) * fluidData.w;
    fluidData.xy += vorticity;

    // Boundary conditions
    fluidData.y *= smoothstep(.8,0.48, abs(uv.y - .5));
    fluidData.x *= smoothstep(.5,.49,abs(uv.x - .5));
    
    // density stability
    fluidData = clamp(fluidData, vec4(vec2(-velocityThreshold), 0.5 , -vorticityThreshold), vec4(vec2(velocityThreshold), 3.0 , vorticityThreshold));
    
    return fluidData;
}

`;

const baseVertexShader = `
varying vec2 vUv; 
void main() {

  vUv = uv; 
  gl_Position = vec4(position, 1.0); 
}
`;

const bufferAFragment = `${utils}

precision highp float;
precision highp int;

varying vec2 vUv; 
uniform vec2 uResolution; 
uniform vec4 uMouse; 

uniform sampler2D textureA; 

void main() {
   vec4 prevMouse = texture2D(textureA, vec2(0.));
    vec2 stepSize = 1./uResolution;


vec2 uv = gl_FragCoord.xy / uResolution.xy;
vec4 col = fluidSolver(textureA, uv, stepSize, uMouse, prevMouse);


if (uMouse.z > 0.0) {
     float dist = distance(vUv, uMouse.xy);
     if (dist < 0.05) { 
       float strength = 1.0 - dist / 0.05;
        col.xy += (uMouse.xy - prevMouse.xy) * strength * 0.01;
   
     }
}

gl_FragColor = col;
  }
`;

const bufferDFragment = `

precision highp float;
precision highp int;

varying vec2 vUv;

uniform vec2 uResolution;
uniform vec4 uMouse;
uniform vec4 prevMouse; 
uniform sampler2D textureA;      
uniform sampler2D colorTexture;  
uniform float uTime; 


#define dt  0.15

float hash1( uint n ) 
{
	n = (n << 13U) ^ n;
    n = n * (n * n * 15731U + 789221U) + 1376312589U;
    return float( n & uvec3(0x7fffffffU))/float(0x7fffffff);
}

// Today's hsv to rgb conversion brought to you by The Book of Shaders.
// https://thebookofshaders.com/06/
vec3 hsv2rgb( in vec3 c ){
    vec3 rgb = clamp(abs(mod(c.x * 6. + vec3(0., 4., 2.),
                             6.) - 3.) - 1., 0., 1.);
    rgb = rgb * rgb * (3. - 2. * rgb);
    return c.z * mix(vec3(1.), rgb, c.y);
}


void main() {
    vec2 uv = gl_FragCoord.xy /uResolution;
    vec2 stepSize = 1.0 / uResolution.xy;
    vec4 vel = texture2D(textureA, vUv);


    vec4 col = texture2D(colorTexture, vUv - dt * vel.xy * stepSize * 3.0);

    vec2 mo = uMouse.xy;
    //vec4 prevMouse = texture2D(prevMouseTexture, vec2(0.), 0.);

    // Draw ink splat
      if(uMouse.z > 0.0 && prevMouse.z > 0.0) {
      float hue = hash1(uint(uMouse.z + uResolution.x*abs(uMouse.z) + uTime));  
      vec4 rgb = vec4(hsv2rgb(vec3(hue, 1., 1.)), 1.);
      float bloom = smoothstep(-.5, .5, (length(mo - prevMouse.xy / uResolution)));
    	col += bloom * 8e-4/pow(length(vUv - mo.xy), 1.6) * rgb;
      }

    // Color decay
    col = clamp(col, 0.0, 5.0);
    col = max(col - (col * 8e-3), 0.0);

    gl_FragColor = col;
}

`;

const finalFragment = `


   uniform vec2 uResolution;
    uniform sampler2D textureA;
    varying vec2 vUv;

    #define PIXEL_SIZE 9.
    #define BORDER_THICKNESS .51
     //#define PIXELATED   
    // #define INVERT_COLORS 

    void main() {
         vec2 uv = gl_FragCoord.xy / uResolution;

        #ifdef PIXELATED
            vec2 dxy = PIXEL_SIZE / uResolution;
            uv = dxy * floor(uv / dxy) + 1. / uResolution;
            vec4 col = textureLod(textureA, uv, 0.);
            vec2 fr = PIXEL_SIZE * (fract(vUv / PIXEL_SIZE) - 0.5);
            col *= step(max(fr.x, fr.y) + BORDER_THICKNESS - PIXEL_SIZE / 2., 0.);
        #else
            vec4 col = textureLod(textureA, uv, 0.);
        #endif

      	if (gl_FragCoord.y < 1. 
#ifdef PIXELATED 
            * PIXEL_SIZE 
#endif
       )
    {
        col = vec4(0.);
    }    
    
#ifndef INVERT_COLORS
    gl_FragColor = vec4(sqrt(col.xyz), 1.);
#else
     gl_FragColor = vec4(sqrt(1. - col.xyz), 1.);
#endif
    }

`;

const options = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
  format: THREE.RGBAFormat,
  type: THREE.FloatType,
};
// render target.
// bufferA.
let rt1 = new THREE.WebGLRenderTarget(sizes.width, sizes.heigth, options);
let rt2 = rt1.clone();

// bufferB.
let rtb1 = new THREE.WebGLRenderTarget(sizes.width, sizes.heigth, options);
let rtb2 = rtb1.clone();

// bufferC.
let rtc1 = new THREE.WebGLRenderTarget(sizes.width, sizes.heigth, options);
let rtc2 = rtb1.clone();

let colorRT1 = new THREE.WebGLRenderTarget(sizes.width, sizes.heigth, options);
let colorRT2 = new THREE.WebGLRenderTarget(sizes.width, sizes.heigth, options);

// --- Create the buffer A .
const bufferAScene = new THREE.Scene();
const materialA = new THREE.ShaderMaterial({
  vertexShader: baseVertexShader,
  fragmentShader: bufferAFragment,
  depthTest: false,

  uniforms: {
    uMouse: {
      value: mouse,
    },
    uResolution: {
      value: new THREE.Vector2(sizes.width, sizes.heigth),
    },
    textureA: {
      value: null,
    },
  },
});
const bufferA = new THREE.Mesh(planeGeo, materialA);
bufferAScene.add(bufferA);

// create buffer B ---
// B prend resultat de A
// D prend resultat de A + B
const bufferBScene = new THREE.Scene();
const materialB = new THREE.ShaderMaterial({
  vertexShader: baseVertexShader,
  fragmentShader: bufferAFragment, // same shader.
  depthTest: false,
  uniforms: {
    uMouse: {
      value: mouse,
    },
    uResolution: {
      value: new THREE.Vector2(sizes.width, sizes.heigth),
    },
    textureA: {
      value: rt2.texture,
    },
  },
});

// buffer C

const bufferCScene = new THREE.Scene();
const materialC = new THREE.ShaderMaterial({
  vertexShader: baseVertexShader,
  fragmentShader: bufferAFragment,
  uniforms: {
    uMouse: {
      value: mouse,
    },
    uResolution: {
      value: new THREE.Vector2(sizes.width, sizes.heigth),
    },
    textureA: {
      value: rtb2.texture,
    },
  },
});
const bufferC = new THREE.Mesh(planeGeo, materialC);
bufferCScene.add(bufferC);

const bufferB = new THREE.Mesh(planeGeo, materialB);
bufferBScene.add(bufferB);

// buffer D
const bufferDScene = new THREE.Scene();
const materialD = new THREE.ShaderMaterial({
  vertexShader: baseVertexShader,
  fragmentShader: bufferDFragment,
  uniforms: {
    uTime: {
      value: 0.1,
    },
    uResolution: {
      value: new THREE.Vector2(sizes.width, sizes.heigth),
    },
    textureA: {
      value: rtc2.texture,
    },
    uMouse: {
      value: mouse,
    },
    prevMouse: {
      value: prevMouse,
    },
    colorTexture: {
      value: colorRT1.texture,
    },
  },
});
const bufferD = new THREE.Mesh(planeGeo, materialD);
bufferDScene.add(bufferD);

const finalMaterial = new THREE.ShaderMaterial({
  vertexShader: baseVertexShader,
  fragmentShader: finalFragment,
  uniforms: {
    uResolution: { value: new THREE.Vector2(sizes.width, sizes.heigth) },
    textureA: { value: null },
  },
});
const finalQuad = new THREE.Mesh(planeGeo, finalMaterial);
scene.add(finalQuad);

// --- Camera & Renderer
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const canvas = document.querySelector(".webgl");
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
init(sizes.width, sizes.heigth, camera, renderer);
renderer.setSize(sizes.width, sizes.heigth);

const clock = new THREE.Clock();
const tick = () => {
  const elapsedTime = clock.getElapsedTime();
  // update materialA
  materialA.uniforms.textureA.value = rt1.texture;
  materialA.uniforms.uMouse.value = mouse;
  renderer.setRenderTarget(rt2);
  renderer.render(bufferAScene, camera);

  [rt1, rt2] = [rt2, rt1];

  // update materialB.
  materialB.uniforms.uMouse.value = mouse;
  materialB.uniforms.textureA.value = rt2.texture; // take prev result from A.
  renderer.setRenderTarget(rtb1); // write in rtb1.
  renderer.render(bufferBScene, camera); // render bufferB scene

  // swap the target
  [rtb1, rtb2] = [rtb2, rtb1];

  // update materialC.
  materialC.uniforms.uMouse.value = mouse;
  materialC.uniforms.textureA.value = rtb2.texture;
  renderer.setRenderTarget(rtc1);
  renderer.render(bufferCScene, camera);

  // swap the target
  [rtc1, rtc2] = [rtc2, rtc1];

  // update materialD.
  materialD.uniforms.uTime.value = performance.now() / 1000;
  materialD.uniforms.colorTexture.value = colorRT1.texture;
  materialD.uniforms.textureA.value = rtc2.texture;
  materialD.uniforms.prevMouse.value = prevMouse;
  materialD.uniforms.uMouse.value = mouse;

  renderer.setRenderTarget(colorRT2);
  renderer.render(bufferDScene, camera);

  // render final texture.
  finalMaterial.uniforms.textureA.value = colorRT2.texture;
  renderer.setRenderTarget(null);

  renderer.render(scene, camera);

  // swap color textures
  [colorRT1, colorRT2] = [colorRT2, colorRT1];

  window.requestAnimationFrame(tick);
};

tick();
