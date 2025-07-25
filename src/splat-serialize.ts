import {
    Color,
    GSplatData,
    Mat3,
    Mat4,
    Quat,
    Vec3
} from 'playcanvas';

import { SHRotation } from './sh-utils';
import { Splat } from './splat';
import { State } from './splat-state';
import { version } from '../package.json';
import { BufferWriter, Writer } from './serialize/writer';
import { ZipWriter } from './serialize/zip-writer';
import indexCss from '../submodules/supersplat-viewer/dist/index.css';
import indexHtml from '../submodules/supersplat-viewer/dist/index.html';
// eslint-disable-next-line import/default
import indexJs from '../submodules/supersplat-viewer/dist/index.js';

type SerializeSettings = {
    maxSHBands?: number;            // specifies the maximum number of bands to be exported
    selected?: boolean;             // only export selected gaussians. used for copy/paste
    minOpacity?: number;            // filter out gaussians with alpha less than or equal to minAlpha
    removeInvalid?: boolean;        // filter out gaussians with invalid data (NaN/Infinity)

    // the following options are used when serializing the PLY for document save
    // and are only supported by serializePly
    keepStateData?: boolean;        // keep the state data array
    keepWorldTransform?: boolean;   // don't apply the world transform when resolving splat transforms
    keepColorTint?: boolean;        // refrain from applying color tints
};

type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    target: 'camera',
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
        }
    }
};

type ExperienceSettings = {
    camera: {
        fov?: number,
        position?: number[],
        target?: number[],
        startAnim: 'none' | 'orbit' | 'animTrack',
        animTrack: string
    },
    background: {
        color?: number[]
    },
    animTracks: AnimTrack[]
};

type ViewerExportSettings = {
    type: 'html' | 'zip';
    experienceSettings: ExperienceSettings;
};

const generatedByString = `Generated by SuperSplat ${version}`;

// used for converting PLY opacity
const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

// create a filter for gaussians
class GaussianFilter {
    set: (splat: Splat) => void;
    test: (i: number) => boolean;

    constructor(serializeSettings: SerializeSettings) {
        let splat: Splat = null;
        let state: Uint8Array = null;
        let opacity: Float32Array = null;

        this.set = (s: Splat) => {
            splat = s;
            state = splat.splatData.getProp('state') as Uint8Array;
            opacity = splat.splatData.getProp('opacity') as Float32Array;
        };

        const onlySelected = serializeSettings.selected ?? false;
        const minOpacity = serializeSettings.minOpacity ?? 0;
        const removeInvalid = serializeSettings.removeInvalid ?? false;

        this.test = (i: number) => {
            // splat is deleted, always removed
            if ((state[i] & State.deleted) !== 0) {
                return false;
            }

            // optionally filter out unselected gaussians
            if (onlySelected && (state[i] !== State.selected)) {
                return false;
            }

            // optionally filter based on opacity
            if (minOpacity > 0 && sigmoid(opacity[i]) < minOpacity) {
                return false;
            }

            if (removeInvalid) {
                const { splatData } = splat;

                // check if any property of the gaussian is NaN/Infinity
                for (let j = 0; j < splatData.elements.length; ++j) {
                    const element = splatData.elements[j];
                    for (let k = 0; k < element.properties.length; ++k) {
                        const prop = element.properties[k];
                        const { storage } = prop;
                        if (storage && !Number.isFinite(storage[i])) {
                            return false;
                        }
                    }
                }
            }

            return true;
        };
    }
}

// count the total number of gaussians given a filter
const countGaussians = (splats: Splat[], filter: GaussianFilter) => {
    return splats.reduce((accum, splat) => {
        filter.set(splat);
        for (let i = 0; i < splat.splatData.numSplats; ++i) {
            accum += filter.test(i) ? 1 : 0;
        }
        return accum;
    }, 0);
};

const getVertexProperties = (splatData: GSplatData) => {
    return new Set<string>(
        splatData.getElement('vertex')
        .properties.filter((p: any) => p.storage)
        .map((p: any) => p.name)
    );
};

const getCommonPropNames = (splats: Splat[]) => {
    let result: Set<string>;

    for (let i = 0; i < splats.length; ++i) {
        const props = getVertexProperties(splats[i].splatData);
        result = i === 0 ? props : new Set([...result].filter(i => props.has(i)));
    }

    return [...result];
};

const getCommonProps = (splats: Splat[]) => {
    const result = new Map<string, Set<string>>();  // map of name->type

    for (let i = 0; i < splats.length; ++i) {
        const properties = splats[i].splatData.getElement('vertex').properties.filter((p: any) => p.storage);
        properties.forEach((p: any) => {
            if (result.has(p.name)) {
                result.get(p.name).add(p.type);
            } else {
                result.set(p.name, new Set([p.type]));
            }
        });
    }

    return [...result].filter(([_, v]) => v.size === 1).map(([name, type]) => {
        return { name, type: type.values().next().value };
    });
};

const shNames = new Array(45).fill('').map((_, i) => `f_rest_${i}`);
const shBandCoeffs = [0, 3, 8, 15];

// determine the number of sh bands present given an object with 'f_rest_*' properties
const calcSHBands = (data: Set<string>) => {
    return { '9': 1, '24': 2, '-1': 3 }[shNames.findIndex(v => !data.has(v))] ?? 0;
};

type DataType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';

const DataTypeSize = (dataType: DataType) => {
    return {
        char: 1,
        uchar: 1,
        short: 2,
        ushort: 2,
        int: 4,
        uint: 4,
        float: 4,
        double: 8
    }[dataType];
};

const v = new Vec3();
const q = new Quat();

// calculate splat transforms on demand and cache the result for next time
class SplatTransformCache {
    getMat: (index: number) => Mat4;
    getRot: (index: number) => Quat;
    getScale: (index: number) => Vec3;
    getSHRot: (index: number) => SHRotation;

    constructor(splat: Splat, keepWorldTransform = false) {
        const transforms = new Map<number, { transformIndex: number, mat: Mat4, rot: Quat, scale: Vec3, shRot: SHRotation }>();
        const indices = splat.transformTexture.getSource() as unknown as Uint32Array;
        const tmpMat = new Mat4();
        const tmpMat3 = new Mat3();
        const tmpQuat = new Quat();

        const getTransform = (index: number) => {
            const transformIndex = indices?.[index] ?? 0;
            let result = transforms.get(transformIndex);
            if (!result) {
                result = { transformIndex, mat: null, rot: null, scale: null, shRot: null };
                transforms.set(transformIndex, result);
            }
            return result;
        };

        this.getMat = (index: number) => {
            const transform = getTransform(index);

            if (!transform.mat) {
                const mat = new Mat4();

                // we must undo the transform we apply at load time to output data
                if (!keepWorldTransform) {
                    mat.setFromEulerAngles(0, 0, -180);
                    mat.mul2(mat, splat.entity.getWorldTransform());
                }

                // combine with transform palette matrix
                if (transform.transformIndex > 0) {
                    splat.transformPalette.getTransform(transform.transformIndex, tmpMat);
                    mat.mul2(mat, tmpMat);
                }

                transform.mat = mat;
            }

            return transform.mat;
        };

        this.getRot = (index: number) => {
            const transform = getTransform(index);

            if (!transform.rot) {
                transform.rot = new Quat().setFromMat4(this.getMat(index));
            }

            return transform.rot;
        };

        this.getScale = (index: number) => {
            const transform = getTransform(index);

            if (!transform.scale) {
                const scale = new Vec3();
                this.getMat(index).getScale(scale);
                transform.scale = scale;
            }

            return transform.scale;
        };

        this.getSHRot = (index: number) => {
            const transform = getTransform(index);

            if (!transform.shRot) {
                tmpQuat.setFromMat4(this.getMat(index));
                tmpMat3.setFromQuat(tmpQuat);
                transform.shRot = new SHRotation(tmpMat3);
            }

            return transform.shRot;
        };
    }
}

// helper class for extracting and transforming a single splat's data
// to prepare it for export
class SingleSplat {
    // final data keyed on member name
    data: any = {};

    // read a single gaussian's data and transform it for export
    read: (splats: Splat, i: number) => void;

    // specify the data members required
    constructor(members: string[], serializeSettings: SerializeSettings) {
        const data: any = {};
        members.forEach((name) => {
            data[name] = 0;
        });

        const hasPosition = ['x', 'y', 'z'].every(v => data.hasOwnProperty(v));
        const hasRotation = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].every(v => data.hasOwnProperty(v));
        const hasScale = ['scale_0', 'scale_1', 'scale_2'].every(v => data.hasOwnProperty(v));
        const hasColor = ['f_dc_0', 'f_dc_1', 'f_dc_2'].every(v => data.hasOwnProperty(v));
        const hasOpacity = data.hasOwnProperty('opacity');

        const dstSHBands = calcSHBands(new Set(Object.keys(data)));
        const dstSHCoeffs = shBandCoeffs[dstSHBands];
        const tmpSHData = dstSHBands ? new Float32Array(dstSHCoeffs) : null;

        type CacheEntry = {
            splat: Splat;
            transformCache: SplatTransformCache;
            srcProps: { [name: string]: Float32Array };
            hasTint: boolean;
        };

        const cacheMap = new Map<Splat, CacheEntry>();
        let cacheEntry: CacheEntry;

        const read = (splat: Splat, i: number) => {
            // get the cached data entry for this splat
            if (splat !== cacheEntry?.splat) {
                if (!cacheMap.has(splat)) {
                    const transformCache = new SplatTransformCache(splat, serializeSettings.keepWorldTransform);

                    const srcPropNames = getVertexProperties(splat.splatData);
                    const srcSHBands = calcSHBands(srcPropNames);
                    const srcSHCoeffs = shBandCoeffs[srcSHBands];

                    // cache the props objects
                    const srcProps: { [name: string]: Float32Array } = {};

                    members.forEach((name) => {
                        const shIndex = shNames.indexOf(name);
                        if (shIndex >= 0) {
                            const a = Math.floor(shIndex / dstSHCoeffs);
                            const b = shIndex % dstSHCoeffs;
                            srcProps[name] = (b < srcSHCoeffs) ? splat.splatData.getProp(shNames[a * srcSHCoeffs + b]) as Float32Array : null;
                        } else {
                            srcProps[name] = splat.splatData.getProp(name) as Float32Array;
                        }
                    });

                    const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint } = splat;
                    const hasTint = (!tintClr.equals(Color.WHITE) || temperature !== 0 || saturation !== 1 || brightness !== 1 || blackPoint !== 0 || whitePoint !== 1);

                    cacheEntry = { splat, transformCache, srcProps, hasTint };

                    cacheMap.set(splat, cacheEntry);
                } else {
                    cacheEntry = cacheMap.get(splat);
                }
            }

            const { transformCache, srcProps, hasTint } = cacheEntry;

            // copy members
            members.forEach((name) => {
                data[name] = srcProps[name]?.[i] ?? 0;
            });

            // apply transform palette transforms
            const mat = transformCache.getMat(i);

            if (hasPosition) {
                v.set(data.x, data.y, data.z);
                mat.transformPoint(v, v);
                [data.x, data.y, data.z] = [v.x, v.y, v.z];
            }

            if (hasRotation) {
                const quat = transformCache.getRot(i);
                q.set(data.rot_1, data.rot_2, data.rot_3, data.rot_0).mul2(quat, q);
                [data.rot_1, data.rot_2, data.rot_3, data.rot_0] = [q.x, q.y, q.z, q.w];
            }

            if (hasScale) {
                const scale = transformCache.getScale(i);
                data.scale_0 = Math.log(Math.exp(data.scale_0) * scale.x);
                data.scale_1 = Math.log(Math.exp(data.scale_1) * scale.y);
                data.scale_2 = Math.log(Math.exp(data.scale_2) * scale.z);
            }

            if (dstSHBands > 0) {
                for (let c = 0; c < 3; ++c) {
                    for (let d = 0; d < dstSHCoeffs; ++d) {
                        tmpSHData[d] = data[shNames[c * dstSHCoeffs + d]];
                    }

                    transformCache.getSHRot(i).apply(tmpSHData);

                    for (let d = 0; d < dstSHCoeffs; ++d) {
                        data[shNames[c * dstSHCoeffs + d]] = tmpSHData[d];
                    }
                }
            }

            if (!serializeSettings.keepColorTint && hasColor && hasTint) {
                const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint } = splat;

                const SH_C0 = 0.28209479177387814;
                const to = (value: number) => value * SH_C0 + 0.5;
                const from = (value: number) => (value - 0.5) / SH_C0;

                const applyTransform = (c: { r: number, g: number, b: number }, s: { r: number, g: number, b: number }, offset: number) => {
                    // offset and scale
                    c.r = offset + c.r * s.r;
                    c.g = offset + c.g * s.g;
                    c.b = offset + c.b * s.b;

                    // saturation
                    const grey = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
                    c.r = grey + (c.r - grey) * saturation;
                    c.g = grey + (c.g - grey) * saturation;
                    c.b = grey + (c.b - grey) * saturation;
                };

                const offset = -blackPoint + brightness;
                const scale = 1 / (whitePoint - blackPoint);

                const s = {
                    r: scale * tintClr.r * (1 + temperature),
                    g: scale * tintClr.g,
                    b: scale * tintClr.b * (1 - temperature)
                };

                const c = {
                    r: to(data.f_dc_0),
                    g: to(data.f_dc_1),
                    b: to(data.f_dc_2)
                };

                applyTransform(c, s, offset);
                data.f_dc_0 = from(c.r);
                data.f_dc_1 = from(c.g);
                data.f_dc_2 = from(c.b);

                if (dstSHBands > 0) {
                    for (let d = 0; d < dstSHCoeffs; ++d) {
                        c.r = data[shNames[d]];
                        c.g = data[shNames[d + dstSHCoeffs]];
                        c.b = data[shNames[d + dstSHCoeffs * 2]];

                        applyTransform(c, s, 0);
                        data[shNames[d]] = c.r;
                        data[shNames[d + dstSHCoeffs]] = c.g;
                        data[shNames[d + dstSHCoeffs * 2]] = c.b;
                    }
                }
            }

            const { transparency } = splat;
            if (!serializeSettings.keepColorTint && hasOpacity && transparency !== 1) {
                const invSig = (value: number) => ((value <= 0) ? -400 : ((value >= 1) ? 400 : -Math.log(1 / value - 1)));
                data.opacity = invSig(sigmoid(data.opacity) * transparency);
            }
        };

        this.data = data;
        this.read = read;
    }
}

const serializePly = async (splats: Splat[], serializeSettings: SerializeSettings, writer: Writer) => {
    const { maxSHBands, keepStateData } = serializeSettings;

    // create filter and count total gaussians
    const filter = new GaussianFilter(serializeSettings);
    const totalGaussians = countGaussians(splats, filter);
    if (totalGaussians === 0) {
        return;
    }

    // this data is filtered out, as it holds internal editor state
    const internalProps = keepStateData ? ['transform'] : ['state', 'transform'];

    const props = getCommonProps(splats)
    // filter out internal props
    .filter(p => !internalProps.includes(p.name))
    // filter out max SH bands
    .filter((p) => {
        if (!p.name.startsWith('f_rest_')) {
            return true;
        }
        const i = parseInt(p.name.slice(7), 10);
        return i < [0, 9, 24, 45][maxSHBands ?? 3];
    });

    const headerText = [
        'ply',
        'format binary_little_endian 1.0',
        // FIXME: disable for now due to other tooling not supporting any header
        // `comment ${generatedByString}`,
        `element vertex ${totalGaussians}`,
        props.map(p => `property ${p.type} ${p.name}`),
        'end_header',
        ''
    ].flat().join('\n');

    // write encoded header
    await writer.write((new TextEncoder()).encode(headerText));

    const singleSplat = new SingleSplat(props.map(p => p.name), serializeSettings);

    const buf = new Uint8Array(1024 * props.reduce((tot, p) => tot + DataTypeSize(p.type), 0));
    const dataView = new DataView(buf.buffer);
    let offset = 0;

    for (let e = 0; e < splats.length; ++e) {
        const splat = splats[e];
        const { splatData } = splat;
        filter.set(splat);

        for (let i = 0; i < splatData.numSplats; ++i) {
            if (!filter.test(i)) continue;

            singleSplat.read(splat, i);

            // write
            for (let j = 0; j < props.length; ++j) {
                if (props[j].type === 'uchar') {
                    dataView.setUint8(offset, singleSplat.data[props[j].name]);
                    offset += 1;
                } else {
                    dataView.setFloat32(offset, singleSplat.data[props[j].name], true);
                    offset += 4;
                }
            }

            // buffer is full, write it to the output stream
            if (offset === buf.byteLength) {
                await writer.write(buf);
                offset = 0;
            }
        }
    }

    // write the last (most likely partially filled) buf
    if (offset > 0) {
        await writer.write(new Uint8Array(buf.buffer, 0, offset));
    }
};

interface CompressedIndex {
    splatIndex: number;
    i: number;
    globalIndex: number;
}

// process and compress a chunk of 256 splats
class Chunk {
    static members = [
        'x', 'y', 'z',
        'scale_0', 'scale_1', 'scale_2',
        'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
        'rot_0', 'rot_1', 'rot_2', 'rot_3'
    ];

    size: number;
    data: any = {};

    // compressed data
    position: Uint32Array;
    rotation: Uint32Array;
    scale: Uint32Array;
    color: Uint32Array;

    constructor(size = 256) {
        this.size = size;
        Chunk.members.forEach((m) => {
            this.data[m] = new Float32Array(size);
        });
        this.position = new Uint32Array(size);
        this.rotation = new Uint32Array(size);
        this.scale = new Uint32Array(size);
        this.color = new Uint32Array(size);
    }

    set(index: number, splat: SingleSplat) {
        Chunk.members.forEach((name) => {
            this.data[name][index] = splat.data[name];
        });
    }

    pack() {
        const calcMinMax = (data: Float32Array) => {
            let min;
            let max;
            min = max = data[0];
            for (let i = 1; i < data.length; ++i) {
                const v = data[i];
                min = Math.min(min, v);
                max = Math.max(max, v);
            }
            return { min, max };
        };

        const normalize = (x: number, min: number, max: number) => {
            if (x <= min) return 0;
            if (x >= max) return 1;
            return (max - min < 0.00001) ? 0 : (x - min) / (max - min);
        };

        const data = this.data;

        const x = data.x;
        const y = data.y;
        const z = data.z;
        const scale_0 = data.scale_0;
        const scale_1 = data.scale_1;
        const scale_2 = data.scale_2;
        const rot_0 = data.rot_0;
        const rot_1 = data.rot_1;
        const rot_2 = data.rot_2;
        const rot_3 = data.rot_3;
        const f_dc_0 = data.f_dc_0;
        const f_dc_1 = data.f_dc_1;
        const f_dc_2 = data.f_dc_2;
        const opacity = data.opacity;

        const px = calcMinMax(x);
        const py = calcMinMax(y);
        const pz = calcMinMax(z);

        const sx = calcMinMax(scale_0);
        const sy = calcMinMax(scale_1);
        const sz = calcMinMax(scale_2);

        // clamp scale because sometimes values are at infinity
        const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
        sx.min = clamp(sx.min, -20, 20);
        sx.max = clamp(sx.max, -20, 20);
        sy.min = clamp(sy.min, -20, 20);
        sy.max = clamp(sy.max, -20, 20);
        sz.min = clamp(sz.min, -20, 20);
        sz.max = clamp(sz.max, -20, 20);

        // convert f_dc_ to colors before calculating min/max and packaging
        const SH_C0 = 0.28209479177387814;
        for (let i = 0; i < f_dc_0.length; ++i) {
            f_dc_0[i] = f_dc_0[i] * SH_C0 + 0.5;
            f_dc_1[i] = f_dc_1[i] * SH_C0 + 0.5;
            f_dc_2[i] = f_dc_2[i] * SH_C0 + 0.5;
        }

        const cr = calcMinMax(f_dc_0);
        const cg = calcMinMax(f_dc_1);
        const cb = calcMinMax(f_dc_2);

        const packUnorm = (value: number, bits: number) => {
            const t = (1 << bits) - 1;
            return Math.max(0, Math.min(t, Math.floor(value * t + 0.5)));
        };

        const pack111011 = (x: number, y: number, z: number) => {
            return packUnorm(x, 11) << 21 |
                   packUnorm(y, 10) << 11 |
                   packUnorm(z, 11);
        };

        const pack8888 = (x: number, y: number, z: number, w: number) => {
            return packUnorm(x, 8) << 24 |
                   packUnorm(y, 8) << 16 |
                   packUnorm(z, 8) << 8 |
                   packUnorm(w, 8);
        };

        // pack quaternion into 2,10,10,10
        const packRot = (x: number, y: number, z: number, w: number) => {
            q.set(x, y, z, w).normalize();
            const a = [q.x, q.y, q.z, q.w];
            const largest = a.reduce((curr, v, i) => (Math.abs(v) > Math.abs(a[curr]) ? i : curr), 0);

            if (a[largest] < 0) {
                a[0] = -a[0];
                a[1] = -a[1];
                a[2] = -a[2];
                a[3] = -a[3];
            }

            const norm = Math.sqrt(2) * 0.5;
            let result = largest;
            for (let i = 0; i < 4; ++i) {
                if (i !== largest) {
                    result = (result << 10) | packUnorm(a[i] * norm + 0.5, 10);
                }
            }

            return result;
        };

        // pack
        for (let i = 0; i < this.size; ++i) {
            this.position[i] = pack111011(
                normalize(x[i], px.min, px.max),
                normalize(y[i], py.min, py.max),
                normalize(z[i], pz.min, pz.max)
            );

            this.rotation[i] = packRot(rot_0[i], rot_1[i], rot_2[i], rot_3[i]);

            this.scale[i] = pack111011(
                normalize(scale_0[i], sx.min, sx.max),
                normalize(scale_1[i], sy.min, sy.max),
                normalize(scale_2[i], sz.min, sz.max)
            );

            this.color[i] = pack8888(
                normalize(f_dc_0[i], cr.min, cr.max),
                normalize(f_dc_1[i], cg.min, cg.max),
                normalize(f_dc_2[i], cb.min, cb.max),
                1 / (1 + Math.exp(-opacity[i]))
            );
        }

        return { px, py, pz, sx, sy, sz, cr, cg, cb };
    }
}

// sort the compressed indices into morton order
const sortSplats = (splats: Splat[], indices: CompressedIndex[]) => {
    // https://fgiesen.wordpress.com/2009/12/13/decoding-morton-codes/
    const encodeMorton3 = (x: number, y: number, z: number) : number => {
        const Part1By2 = (x: number) => {
            x &= 0x000003ff;
            x = (x ^ (x << 16)) & 0xff0000ff;
            x = (x ^ (x <<  8)) & 0x0300f00f;
            x = (x ^ (x <<  4)) & 0x030c30c3;
            x = (x ^ (x <<  2)) & 0x09249249;
            return x;
        };

        return (Part1By2(z) << 2) + (Part1By2(y) << 1) + Part1By2(x);
    };

    let minx: number;
    let miny: number;
    let minz: number;
    let maxx: number;
    let maxy: number;
    let maxz: number;

    // calculate scene extents across all splats (using sort centers, because they're in world space)
    for (let i = 0; i < splats.length; ++i) {
        const splat = splats[i];
        const splatData = splat.splatData;
        const state = splatData.getProp('state') as Uint8Array;
        const { centers } = splat.entity.gsplat.instance.sorter;

        for (let i = 0; i < splatData.numSplats; ++i) {
            if ((state[i] & State.deleted) === 0) {
                const x = centers[i * 3 + 0];
                const y = centers[i * 3 + 1];
                const z = centers[i * 3 + 2];

                if (minx === undefined) {
                    minx = maxx = x;
                    miny = maxy = y;
                    minz = maxz = z;
                } else {
                    if (x < minx) minx = x; else if (x > maxx) maxx = x;
                    if (y < miny) miny = y; else if (y > maxy) maxy = y;
                    if (z < minz) minz = z; else if (z > maxz) maxz = z;
                }
            }
        }
    }

    const xlen = maxx - minx;
    const ylen = maxy - miny;
    const zlen = maxz - minz;

    const morton = new Uint32Array(indices.length);
    let idx = 0;
    for (let i = 0; i < splats.length; ++i) {
        const splat = splats[i];
        const splatData = splat.splatData;
        const state = splatData.getProp('state') as Uint8Array;
        const { centers } = splat.entity.gsplat.instance.sorter;

        for (let i = 0; i < splatData.numSplats; ++i) {
            if ((state[i] & State.deleted) === 0) {
                const x = centers[i * 3 + 0];
                const y = centers[i * 3 + 1];
                const z = centers[i * 3 + 2];

                const ix = Math.min(1023, Math.floor(1024 * (x - minx) / xlen));
                const iy = Math.min(1023, Math.floor(1024 * (y - miny) / ylen));
                const iz = Math.min(1023, Math.floor(1024 * (z - minz) / zlen));

                morton[idx++] = encodeMorton3(ix, iy, iz);
            }
        }
    }

    // order splats by morton code
    indices.sort((a, b) => morton[a.globalIndex] - morton[b.globalIndex]);
};

const serializePlyCompressed = async (splats: Splat[], options: SerializeSettings, writer: Writer) => {
    const { maxSHBands } = options;

    // create filter and count total gaussians
    const filter = new GaussianFilter(options);

    // make a list of indices spanning all splats (so we can sort them together)
    const indices: CompressedIndex[] = [];
    for (let splatIndex = 0; splatIndex < splats.length; ++splatIndex) {
        const splatData = splats[splatIndex].splatData;
        filter.set(splats[splatIndex]);
        for (let i = 0; i < splatData.numSplats; ++i) {
            if (filter.test(i)) {
                indices.push({ splatIndex, i, globalIndex: indices.length });
            }
        }
    }

    if (indices.length === 0) {
        console.error('nothing to export');
        return;
    }

    const numSplats = indices.length;
    const numChunks = Math.ceil(numSplats / 256);

    const chunkProps = [
        'min_x', 'min_y', 'min_z',
        'max_x', 'max_y', 'max_z',
        'min_scale_x', 'min_scale_y', 'min_scale_z',
        'max_scale_x', 'max_scale_y', 'max_scale_z',
        'min_r', 'min_g', 'min_b',
        'max_r', 'max_g', 'max_b'
    ];

    const vertexProps = [
        'packed_position',
        'packed_rotation',
        'packed_scale',
        'packed_color'
    ];

    // calculate the number of output bands given the scene splat data and
    // user-chosen maxSHBands
    const outputSHBands = (() => {
        const splatBands = splats.map(s => calcSHBands(getVertexProperties(s.splatData)));
        return Math.min(maxSHBands ?? 3, Math.max(...splatBands));
    })();
    const outputSHCoeffs = shBandCoeffs[outputSHBands];

    const shHeader = outputSHBands ? [
        `element sh ${numSplats}`,
        new Array(outputSHCoeffs * 3).fill('').map((_, i) => `property uchar f_rest_${i}`)
    ].flat() : [];

    const headerText = [
        'ply',
        'format binary_little_endian 1.0',
        `comment ${generatedByString}`,
        `element chunk ${numChunks}`,
        chunkProps.map(p => `property float ${p}`),
        `element vertex ${numSplats}`,
        vertexProps.map(p => `property uint ${p}`),
        shHeader,
        'end_header\n'
    ].flat().join('\n');

    const header = (new TextEncoder()).encode(headerText);

    const result = new Uint8Array(
        header.byteLength +
        numChunks * chunkProps.length * 4 +
        numSplats * vertexProps.length * 4 +
        outputSHCoeffs * 3 * numSplats
    );
    const dataView = new DataView(result.buffer);

    result.set(header);

    const chunkOffset = header.byteLength;
    const vertexOffset = chunkOffset + numChunks * chunkProps.length * 4;
    const shOffset = vertexOffset + numSplats * 4 * 4;

    // sort splats into some kind of order (morton order rn)
    sortSplats(splats, indices);

    const chunk = new Chunk();
    const singleSplat = new SingleSplat([
        'x', 'y', 'z',
        'scale_0', 'scale_1', 'scale_2',
        'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
        'rot_0', 'rot_1', 'rot_2', 'rot_3'
    ].concat(shNames.slice(0, outputSHCoeffs * 3)), options);

    for (let i = 0; i < numChunks; ++i) {
        const num = Math.min(numSplats, (i + 1) * 256) - i * 256;
        for (let j = 0; j < num; ++j) {
            const index = indices[i * 256 + j];

            // read splat
            singleSplat.read(splats[index.splatIndex], index.i);

            // update chunk
            chunk.set(j, singleSplat);

            // quantize and write sh data
            let off = shOffset + (i * 256 + j) * outputSHCoeffs * 3;
            for (let k = 0; k < outputSHCoeffs * 3; ++k) {
                const nvalue = singleSplat.data[shNames[k]] / 8 + 0.5;
                dataView.setUint8(off++, Math.max(0, Math.min(255, Math.trunc(nvalue * 256))));
            }
        }

        // pad the end of the last chunk with duplicate data
        if (num < 256) {
            for (let j = num; j < 256; ++j) {
                chunk.set(j, singleSplat);
            }
        }

        const result = chunk.pack();

        const off = chunkOffset + i * 18 * 4;

        // write chunk data
        dataView.setFloat32(off + 0, result.px.min, true);
        dataView.setFloat32(off + 4, result.py.min, true);
        dataView.setFloat32(off + 8, result.pz.min, true);
        dataView.setFloat32(off + 12, result.px.max, true);
        dataView.setFloat32(off + 16, result.py.max, true);
        dataView.setFloat32(off + 20, result.pz.max, true);

        dataView.setFloat32(off + 24, result.sx.min, true);
        dataView.setFloat32(off + 28, result.sy.min, true);
        dataView.setFloat32(off + 32, result.sz.min, true);
        dataView.setFloat32(off + 36, result.sx.max, true);
        dataView.setFloat32(off + 40, result.sy.max, true);
        dataView.setFloat32(off + 44, result.sz.max, true);

        dataView.setFloat32(off + 48, result.cr.min, true);
        dataView.setFloat32(off + 52, result.cg.min, true);
        dataView.setFloat32(off + 56, result.cb.min, true);
        dataView.setFloat32(off + 60, result.cr.max, true);
        dataView.setFloat32(off + 64, result.cg.max, true);
        dataView.setFloat32(off + 68, result.cb.max, true);

        // write splat data
        const offset = vertexOffset + i * 256 * 4 * 4;
        const chunkSplats = Math.min(numSplats, (i + 1) * 256) - i * 256;
        for (let j = 0; j < chunkSplats; ++j) {
            dataView.setUint32(offset + j * 4 * 4 + 0, chunk.position[j], true);
            dataView.setUint32(offset + j * 4 * 4 + 4, chunk.rotation[j], true);
            dataView.setUint32(offset + j * 4 * 4 + 8, chunk.scale[j], true);
            dataView.setUint32(offset + j * 4 * 4 + 12, chunk.color[j], true);
        }
    }

    await writer.write(result, true);
};

const serializeSplat = async (splats: Splat[], options: SerializeSettings, writer: Writer) => {
    // create filter and count total gaussians
    const filter = new GaussianFilter(options);
    const totalGaussians = countGaussians(splats, filter);
    if (totalGaussians === 0) {
        return;
    }

    // position.xyz: float32, scale.xyz: float32, color.rgba: uint8, quaternion.ijkl: uint8
    const result = new Uint8Array(totalGaussians * 32);
    const dataView = new DataView(result.buffer);

    let idx = 0;

    const props = ['x', 'y', 'z', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'scale_0', 'scale_1', 'scale_2'];
    const singleSplat = new SingleSplat(props, options);
    const { data } = singleSplat;

    const clamp = (x: number) => Math.max(0, Math.min(255, x));
    const SH_C0 = 0.28209479177387814;

    for (let e = 0; e < splats.length; ++e) {
        const splat = splats[e];
        const { splatData } = splat;
        filter.set(splat);

        for (let i = 0; i < splatData.numSplats; ++i) {
            if (!filter.test(i)) continue;

            singleSplat.read(splat, i);

            const off = idx++ * 32;

            dataView.setFloat32(off + 0, data.x, true);
            dataView.setFloat32(off + 4, data.y, true);
            dataView.setFloat32(off + 8, data.z, true);

            dataView.setFloat32(off + 12, Math.exp(data.scale_0), true);
            dataView.setFloat32(off + 16, Math.exp(data.scale_1), true);
            dataView.setFloat32(off + 20, Math.exp(data.scale_2), true);

            dataView.setUint8(off + 24, clamp((0.5 + SH_C0 * data.f_dc_0) * 255));
            dataView.setUint8(off + 25, clamp((0.5 + SH_C0 * data.f_dc_1) * 255));
            dataView.setUint8(off + 26, clamp((0.5 + SH_C0 * data.f_dc_2) * 255));
            dataView.setUint8(off + 27, clamp((1 / (1 + Math.exp(-data.opacity))) * 255));

            dataView.setUint8(off + 28, clamp(data.rot_0 * 128 + 128));
            dataView.setUint8(off + 29, clamp(data.rot_1 * 128 + 128));
            dataView.setUint8(off + 30, clamp(data.rot_2 * 128 + 128));
            dataView.setUint8(off + 31, clamp(data.rot_3 * 128 + 128));
        }
    }

    await writer.write(result, true);
};

const encodeBase64 = (bytes: Uint8Array) => {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
};

const serializeViewer = async (splats: Splat[], serializeSettings: SerializeSettings, options: ViewerExportSettings, writer: Writer) => {
    const { experienceSettings } = options;

    // create compressed PLY data
    const plyWriter = new BufferWriter();
    await serializePlyCompressed(splats, serializeSettings, plyWriter);
    const plyBuffer = plyWriter.close();

    if (options.type === 'html') {
        const pad = (text: string, spaces: number) => {
            const whitespace = ' '.repeat(spaces);
            return text.split('\n').map(line => whitespace + line).join('\n');
        };

        const style = '<link rel="stylesheet" href="./index.css">';
        const script = '<script type="module" src="./index.js"></script>';
        const settings = 'settings: fetch(settingsUrl).then(response => response.json())';
        const content = 'fetch(contentUrl)';

        const html = indexHtml
        .replace(style, `<style>\n${pad(indexCss, 12)}\n        </style>`)
        .replace(script, `<script type="module">\n${pad(indexJs, 12)}\n        </script>`)
        .replace(settings, `settings: ${JSON.stringify(experienceSettings)}`)
        .replace(content, `fetch("data:application/ply;base64,${encodeBase64(plyBuffer)}")`);

        await writer.write(new TextEncoder().encode(html), true);
    } else {
        const zipWriter = new ZipWriter(writer);
        await zipWriter.file('index.html', indexHtml);
        await zipWriter.file('index.css', indexCss);
        await zipWriter.file('index.js', indexJs);
        await zipWriter.file('settings.json', JSON.stringify(experienceSettings, null, 4));
        await zipWriter.file('scene.compressed.ply', plyBuffer);
        await zipWriter.close();
    }
};

export {
    Writer,
    serializePly,
    serializePlyCompressed,
    serializeSplat,
    serializeViewer,
    AnimTrack,
    ExperienceSettings,
    SerializeSettings,
    ViewerExportSettings
};
