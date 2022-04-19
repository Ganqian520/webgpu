import basicVert from './shaders/basic.vert.wgsl?raw'
import positionFrag from './shaders/position.frag.wgsl?raw'
import * as cube from './util/cube'
import { getMvpMatrix } from './util/math'

// initialize webgpu device & config canvas context
async function initWebGPU(canvas: HTMLCanvasElement) {
    if(!navigator.gpu)
        throw new Error('Not Support WebGPU')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter)
        throw new Error('No Adapter Found')
    const device = await adapter.requestDevice()
    const context = canvas.getContext('webgpu') as GPUCanvasContext
    const format = context.getPreferredFormat(adapter)
    const devicePixelRatio = window.devicePixelRatio || 1
    const size = {
        width: canvas.clientWidth * devicePixelRatio,
        height: canvas.clientHeight * devicePixelRatio,
    }
    context.configure({
        device, format, size,
        // prevent chrome warning after v102
        compositingAlphaMode: 'opaque'
    })
    return {device, context, format, size}
}

// create pipiline & buffers
async function initPipeline(device: GPUDevice, format: GPUTextureFormat, size:{width:number, height:number}) {
    const pipeline = await device.createRenderPipelineAsync({
        label: 'Basic Pipline',
        vertex: {
            module: device.createShaderModule({
                code: basicVert,
            }),
            entryPoint: 'main',
            buffers: [{
                arrayStride: 5 * 4, // 3 position 2 uv,
                attributes: [
                    {
                        // position
                        shaderLocation: 0,
                        offset: 0,
                        format: 'float32x3',
                    },
                    {
                        // uv
                        shaderLocation: 1,
                        offset: 3 * 4,
                        format: 'float32x2',
                    }
                ]
            }]
        },
        fragment: {
            module: device.createShaderModule({
                code: positionFrag,
            }),
            entryPoint: 'main',
            targets: [
                {
                    format: format
                }
            ]
        },
        primitive: {
            topology: 'triangle-list',
            // Culling backfaces pointing away from the camera
            cullMode: 'back'
        },
        // Enable depth testing since we have z-level positions
        // Fragment closest to the camera is rendered in front
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: 'depth24plus',
        }
    } as GPURenderPipelineDescriptor)
    // create vertex buffer
    const vertexBuffer = device.createBuffer({
        label: 'GPUBuffer store vertex',
        size: cube.vertex.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(vertexBuffer, 0, cube.vertex)

    // create a (256 + 4 * 16) matrix3
    const buffer = device.createBuffer({
        label: 'GPUBuffer store 2 4*4 matrix',
        size: 256 + 4 * 16, // 2 matrix with 256-byte aligned
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    //create two groups with different offset for matrix3
    const group1 = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: buffer,
                    offset: 0,
                    size: 4 * 16
                }
            }
        ]
    })
    // group with 256-byte offset
    const group2 = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: buffer,
                    offset: 256, // must be 256-byte aligned
                    size: 4 * 16
                }
            }
        ]
    })
    // create depthTexture for renderPass
    const depthTexture = device.createTexture({
        size, format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    // return all vars
    return {pipeline, vertexBuffer, buffer, group1, group2, depthTexture}
}

// create & submit device commands
function draw(
    device: GPUDevice, 
    context: GPUCanvasContext,
    piplineObj: {
        pipeline: GPURenderPipeline,
        vertexBuffer: GPUBuffer,
        buffer: GPUBuffer,
        group1: GPUBindGroup,
        group2: GPUBindGroup,
        depthTexture: GPUTexture
    }
) {
    // start encoder
    const commandEncoder = device.createCommandEncoder()
    const renderPassDescriptor: GPURenderPassDescriptor = {
        colorAttachments: [
            {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
                // before v101
                loadValue: { r: 0, g: 0, b: 0, a: 1.0 }
            }
        ],
        depthStencilAttachment: {
            view: piplineObj.depthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        }
    }
    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor)
    passEncoder.setPipeline(piplineObj.pipeline)
    // set vertex
    passEncoder.setVertexBuffer(0, piplineObj.vertexBuffer)
    {
        // draw first cube
        passEncoder.setBindGroup(0, piplineObj.group1)
        passEncoder.draw(cube.vertexCount)
        // draw second cube
        passEncoder.setBindGroup(0, piplineObj.group2)
        passEncoder.draw(cube.vertexCount)
    }
    // endPass is deprecated after v101
    passEncoder.end ? passEncoder.end() : passEncoder.endPass()
    // webgpu run in a separate process, all the commands will be executed after submit
    device.queue.submit([commandEncoder.finish()])
}

async function run(){
    const canvas = document.querySelector('canvas')
    if (!canvas)
        throw new Error('No Canvas')
    const {device, context, format, size} = await initWebGPU(canvas)
    const piplineObj = await initPipeline(device, format, size)
    // defaut state
    let aspect = size.width/ size.height
    const position1 = {x:2, y:0, z: -7}
    const rotation1 = {x: 0, y: 0, z:0}
    const scale1 = {x:1, y:1, z: 1}
    const position2 = {x:-2, y:0, z: -7}
    const rotation2 = {x: 0, y: 0, z:0}
    const scale2 = {x:1, y:1, z: 1}
    // start loop
    function frame(){
        // first, update two transform matrixs
        const now = Date.now() / 1000
        {
            // first cube
            rotation1.x = Math.sin(now)
            rotation1.y = Math.cos(now)
            const mvpMatrix1 = getMvpMatrix(aspect, position1, rotation1, scale1)
            device.queue.writeBuffer(
                piplineObj.buffer,
                0,
                mvpMatrix1
            )
        }
        {
            // second cube with 256-byte offset
            rotation2.x = Math.cos(now)
            rotation2.y = Math.sin(now)
            const mvpMatrix2 = getMvpMatrix(aspect, position2, rotation2, scale2)
            device.queue.writeBuffer(
                piplineObj.buffer,
                256, // aligned at 256-byte 
                mvpMatrix2
            )
        }
        draw(device, context, piplineObj)
        requestAnimationFrame(frame)
    }
    frame()

    // re-configure context on resize
    window.addEventListener('resize', ()=>{
        size.width = canvas.clientWidth * devicePixelRatio
        size.height = canvas.clientHeight * devicePixelRatio
        // reconfigure canvas
        context.configure({
            device, format, size,
            compositingAlphaMode: 'opaque'
        })
        // re-create depth texture
        piplineObj.depthTexture.destroy()
        piplineObj.depthTexture = device.createTexture({
            size, format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        // update aspect
        aspect = size.width/ size.height
    })
}
run()