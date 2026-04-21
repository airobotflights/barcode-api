import Fastify from 'fastify';
import { readBarcodes } from 'zxing-wasm';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pdfjsBaseUrl = path.dirname(require.resolve('pdfjs-dist/package.json'));

pdfjsLib.GlobalWorkerOptions.workerSrc = `${pdfjsBaseUrl}/legacy/build/pdf.worker.min.mjs`;

const fastify = Fastify({
    logger: false,
    bodyLimit: 50 * 1024 * 1024,
});

const PORT = 6666;

fastify.server.setTimeout(500000);

fastify.post('/api/barcode', async (request, reply) => {
    const {
        base64,
        tryHarder = true,
        scale = 2,
        stopAtFirst = true,
    } = request.body || {};

    if (!base64 || typeof base64 !== 'string') {
        return reply.code(400).send({ error: 'base64 required' });
    }

    try {
        const cleanBase64 = base64
            .replace(/^data:application\/pdf;base64,/i, '')
            .replace(/\s+/g, '');

        const buffer = Buffer.from(cleanBase64, 'base64');

        if (!buffer.length) {
            return reply.code(400).send({ error: 'empty decoded pdf buffer' });
        }

        const pdf = await pdfjsLib.getDocument({
            data: new Uint8Array(buffer),
            cMapUrl: `${pdfjsBaseUrl}/cmaps/`,
            cMapPacked: true,
            standardFontDataUrl: `${pdfjsBaseUrl}/standard_fonts/`,
            useWasm: true,
            wasmUrl: `${pdfjsBaseUrl}/wasm/`,
            isImageDecoderSupported: false,
            enableHWA: true,
        }).promise;

        const out = [];

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale });

            const { canvas, context } = pdf.canvasFactory.create(
                viewport.width,
                viewport.height
            );

            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);

            const intent = 'display';

            await page.render({
                canvas: null,
                canvasContext: context,
                viewport,
                intent,
                optionalContentConfigPromise: pdf.getOptionalContentConfig({ intent }),
            }).promise;

            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

            const results = await readBarcodes({
                data: imageData.data,
                width: imageData.width,
                height: imageData.height,
            }, {
                tryHarder,
            });

            page.cleanup();
            canvas.width = 0;
            canvas.height = 0;

            if (results.length) {
                out.push(...results.map((r) => ({
                    page: pageNumber,
                    text: r.text,
                    format: r.format,
                })));

                if (stopAtFirst) {
                    break;
                }
            }
        }

        void pdf.cleanup();

        return {
            found: out.length > 0,
            results: out,
        };
    } catch (e) {
        console.log(e)
        return reply.code(400).send({
            error: 'invalid pdf',
            message: e?.message || String(e),
        });
    }
});

await fastify.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Listening on http://127.0.0.1:${PORT}`);