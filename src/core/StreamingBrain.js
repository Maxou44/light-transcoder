import MediaAnalyzer from './analyze/MediaAnalyzer';
import { getLanguage, getDuration, getVideoTracks, getAudioTracks, canDirectPlay, analyzeAudioStreams, analyzeVideoStreams } from './analyze/CompareFunctions';

export default class StreamingBrain {

    constructor(input = '') {
        this._input = input;
        this._meta = false;
    }

    async getMeta() {
        return await this.analyse();
    }

    async analyse() {
        if (!this._meta)
            this._meta = await (new MediaAnalyzer(this._input)).analyze();
        return this._meta;
    }

    async getTracks() {
        await this.analyse();

        if (!this._meta)
            return {};

        const videoStreams = this._meta.meta.streams.filter(e => (e.codec_type === 'video')).map((e, i) => ({
            id: i,
            language: getLanguage(e),
            codec: e.codec_name || 'unknown',
            codec_name: e.codec_long_name || 'Unknown',
        }));

        const audioStreams = this._meta.meta.streams.filter(e => (e.codec_type === 'audio')).map((e, i) => ({
            id: i,
            language: getLanguage(e),
            codec: e.codec_name || 'unknown',
            codec_name: e.codec_long_name || 'Unknown',
        }));

        return {
            video: videoStreams,
            audio: audioStreams,
            subtitle: [],
        }
    }

    async takeDecision(compatibilityMap, profile, videoStreams, audioStreams) {
        await this.analyse();
        const videoStreamsMeta = getVideoTracks(this._meta.meta);
        const audioStreamsMeta = getAudioTracks(this._meta.meta);
        const duration = getDuration(this._meta.meta);

        const downloadMap = compatibilityMap.find((e) => (e.type === 'DOWNLOAD'));
        const dashMap = compatibilityMap.find((e) => (e.type === 'DASH'));
        const hlsMap = compatibilityMap.find((e) => (e.type === 'HLS'));

        // console.log('DIRECT PLAY STATUS', canDirectPlay(this._meta.meta, downloadMap)[1])

        // DOWNLOAD
        if (downloadMap && canDirectPlay(this._meta.meta, downloadMap)[0]) {
            return {
                protocol: 'DOWNLOAD',
                duration,
                chunkDuration: 0,
                startChunkAt: 0,
                streams: [],
            }
        }

        // DASH
        if (dashMap) {
            const analyzedVideoStreams = analyzeVideoStreams(this._input, videoStreams, videoStreamsMeta, profile, dashMap);
            const analyzedAudioStreams = analyzeAudioStreams(this._input, audioStreams, audioStreamsMeta, profile, dashMap, (analyzedVideoStreams.length ? analyzedVideoStreams[0].startDelay : 0));
            return {
                protocol: 'DASH',
                duration,
                chunkDuration: profile.chunkDuration,
                startChunkAt: 0,
                streams: [...analyzedVideoStreams, ...analyzedAudioStreams],
            }
        }

        // HLS
        if (hlsMap) {
            const analyzedVideoStreams = analyzeVideoStreams(this._input, videoStreams, videoStreamsMeta, profile, hlsMap);
            const analyzedAudioStreams = analyzeAudioStreams(this._input, audioStreams, audioStreamsMeta, profile, hlsMap, (analyzedVideoStreams.length ? analyzedVideoStreams[0].startDelay : 0));
            return {
                protocol: 'HLS',
                duration,
                chunkDuration: profile.chunkDuration,
                startChunkAt: 0,
                streams: [...analyzedVideoStreams, ...analyzedAudioStreams]
            }
        }

        console.error('Failed to stream file, it\'s sad!')
        return false;
    }

    // Force to fit a resolution inside an other other (and keep the same ratio)
    calcOutputResolution(width, height, maxWidth, maxHeight) {
        // Calc ratio
        const ratio = width / height;

        // Default case
        if (width <= maxWidth && height <= maxHeight)
            return { width, height, resized: false };

        // We need to calc %2 values (Else, we will have issues with ffmpeg)
        const widthCase1 = Math.ceil(maxWidth) - (Math.ceil(maxWidth) % 2 !== 0);
        const heightCase1 = Math.ceil(maxWidth / ratio) - (Math.ceil(maxWidth / ratio) % 2 !== 0);
        const widthCase2 = Math.ceil(maxHeight * ratio) - (Math.ceil(maxHeight * ratio) % 2 !== 0);
        const heightCase2 = Math.ceil(maxHeight) + (Math.ceil(maxHeight) % 2 !== 0);

        // Get the right value
        if (widthCase1 <= maxWidth && heightCase1 <= maxHeight && widthCase1 > 0 && heightCase1 > 0)
            return { width: widthCase1, height: heightCase1, resized: true };
        if (widthCase2 <= maxWidth && heightCase2 <= maxHeight && widthCase2 > 0 && heightCase2 > 0)
            return { width: widthCase2, height: heightCase2, resized: true };

        // Default fallback
        return { width, height, resized: false };
    }

    async getProfiles() {
        // Analyse the file if needed
        await this.analyse();

        // List of qualities
        const qualities = [
            { height: 160, width: 285, bitrates: [250] },
            { height: 240, width: 430, bitrates: [500] },
            { height: 350, width: 625, bitrates: [750] },
            { height: 480, width: 855, bitrates: [1250] },
            { height: 576, width: 1024, bitrates: [1750] },
            { height: 720, width: 1280, bitrates: [2000, 3000, 4000] },
            { height: 1080, width: 1920, bitrates: [8000, 10000, 12000, 20000] },
            { height: 1440, width: 2560, bitrates: [22000, 30000] },
            { height: 2160, width: 3840, bitrates: [50000, 60000, 70000, 80000] },
            { height: 4320, width: 7680, bitrates: [140000] },
        ];

        // Get resolution
        const resolution = this._meta.global.resolution;

        // Filter to avoid higher resolution than original file
        const filtered = qualities.filter((e) => (e.width <= resolution.width && e.height <= resolution.height)).map(e => ({ ...e, ...this.calcOutputResolution(resolution.width, resolution.height, e.width, e.height), original: false }));

        // Add a "Original" version with the original bitrate
        filtered.push({ height: resolution.height, width: resolution.width, bitrates: [Math.round(this._meta.global.bitrate / 1024)], original: true, resized: false })

        // Return the array of profiles with real output resolution and id
        const toOrder = filtered.reduce((acc, e) => ([...acc, ...e.bitrates.map((b, qualityIndex) => ({ ...e, bitrate: b, bitrates: undefined, qualityIndex }))]), []);

        // Sort by height and bitrate
        toOrder.sort((a, b) => ((a.height !== b.height) ? a.height - b.height : a.bitrate - b.bitrate));

        // Return with index
        return toOrder.map((e, i) => ({ ...e, id: i }))
    }

    async getProfile(id = 0) {
        // Get profiles
        const profiles = await this.getProfiles();

        // Error
        if (!profiles[id])
            return false;

        // Select profile
        const profile = profiles[id];

        // x264 codec specific stuff
        const x264subme = (profile.height <= 480) ? 2 : 0;
        const x264crf = [24, 22, 20, 18][profile.qualityIndex] || 23;
        const x264preset = ['slow', 'medium', 'fast', 'veryfast'][profile.qualityIndex] || 'fast';

        // Chunk duration
        const chunkDuration = 8;

        // Calculate approximative bitrates
        const audioBitrate = (10 * profile.bitrate / 100) < 64 ? 64 : (10 * profile.bitrate / 100) > 2048 ? 2048 : Math.round(10 * profile.bitrate / 100);
        const videoBitrate = Math.round((profile.bitrate - audioBitrate) * 0.98);

        // Return encoder settings
        return { ...profile, x264subme, x264crf, x264preset, audioBitrate, videoBitrate, chunkDuration };
    }
}