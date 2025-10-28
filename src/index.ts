import { Hono } from 'hono';
import Replicate from 'replicate';

interface Env {
        REPLICATE_API_TOKEN: string;
        CLOUDFLARE_ACCOUNT_ID: string;
        CLOUDFLARE_IMAGES_API_TOKEN: string;
        BRIA_API_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

// Helper function to upload image to Cloudflare Images
async function uploadToCloudflareImages(
        imageUrl: string,
        accountId: string,
        apiToken: string
): Promise<string> {
        try {
                // Fetch the image from Replicate
                console.log("accountId", accountId);
                console.log("apiToken", apiToken);
                console.log("imageUrl", imageUrl);
                const imageResponse = await fetch(imageUrl);
                if (!imageResponse.ok) {
                        throw new Error(`Failed to fetch image: ${imageResponse.status}`);
                }

                const imageBytes = await imageResponse.arrayBuffer();

                // Create form data for upload
                const formData = new FormData();
                formData.append('file', new File([imageBytes], 'generated-image.jpg', { type: 'image/jpeg' }));

                // Upload to Cloudflare Images
                const uploadResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`, {
                        method: 'POST',
                        headers: {
                                'Authorization': `Bearer ${apiToken}`,
                        },
                        body: formData,
                });

                if (!uploadResponse.ok) {
                        const errorText = await uploadResponse.text();
                        throw new Error(`Cloudflare Images upload failed: ${uploadResponse.status} - ${errorText}`);
                }

                const uploadResult = await uploadResponse.json() as any;

                if (!uploadResult.success) {
                        throw new Error(`Cloudflare Images upload failed: ${JSON.stringify(uploadResult.errors)}`);
                }

                // Return the delivery URL for the uploaded image
                return uploadResult.result.variants[0]; // Get the first variant URL
        } catch (error) {
                console.error('Error uploading to Cloudflare Images:', error);
                throw error;
        }
}

app.post('/generate-image', async (c) => {
        try {
                // Require Replicate API token from header
                const userToken = c.req.header('X-Replicate-Api-Token');
                if (!userToken) {
                        return c.json({ error: 'Missing Replicate API token. Please provide it in the X-Replicate-Api-Token header.' }, 400);
                }
                const replicate = new Replicate({ auth: userToken });
                const model = 'black-forest-labs/flux-kontext-pro';

                const { prompt, structured_prompt } = await c.req.json();

                // Generate image with Replicate
                const output: any = await replicate.run(model, {
                        input: {
                                prompt,
                                structured_prompt
                        },
                });

                // Normalize output to an image URL string
                let replicateImageUrl: string;
                if (typeof output === 'string') {
                        replicateImageUrl = output;
                } else if (Array.isArray(output)) {
                        const first = output[0];
                        if (typeof first === 'string') {
                                replicateImageUrl = first;
                        } else if (first && typeof first.url === 'function') {
                                replicateImageUrl = first.url();
                        } else if (first && typeof first.url === 'string') {
                                replicateImageUrl = first.url;
                        } else {
                                throw new Error('Unexpected output format from model');
                        }
                } else if (output && typeof output.url === 'function') {
                        replicateImageUrl = output.url();
                } else if (output && typeof output.url === 'string') {
                        replicateImageUrl = output.url;
                } else {
                        throw new Error('Unexpected output format from model');
                }

                // Upload to Cloudflare Images for permanent storage
                //const cloudflareImageUrl = await uploadToCloudflareImages(
                //        replicateImageUrl,
                //        c.env.CLOUDFLARE_ACCOUNT_ID,
                //        c.env.CLOUDFLARE_IMAGES_API_TOKEN
                //);

                // Return the Cloudflare Images URL instead of the temporary Replicate URL
                //return c.json({ imageUrl: cloudflareImageUrl });
                return c.json({ imageUrl: replicateImageUrl });
        } catch (err) {
                console.error('Error in generate-image:', err);
                const message = err instanceof Error ? err.message : String(err);
                return c.json({ error: message }, 500);
        }
});

export default app;

// BRIA endpoint: generate and refine images using BRIA API
app.post('/generate-image-with-bria', async (c) => {
        try {
                const { prompt, structured_prompt, seed, image, imageUrl, images } = await c.req.json();

                // Build payload for BRIA
                const payload: Record<string, any> = {};
                if (prompt) payload.prompt = prompt;
                if (structured_prompt) payload.structured_prompt = structured_prompt;
                if (typeof seed === 'number') payload.seed = seed;

                // Support either direct URL via "images" field, or base64 image via "image"
                if (typeof images === 'string' && images.length > 0) {
                        payload.images = images;
                } else if (typeof image === 'string' && image.length > 0) {
                        // assume client provided raw base64 (no data URI prefix)
                        payload.image = image;
                } else if (typeof imageUrl === 'string' && imageUrl.length > 0) {
                        // Fetch and convert to base64 string
                        const resp = await fetch(imageUrl);
                        if (!resp.ok) {
                                throw new Error(`Failed to fetch image URL: ${resp.status}`);
                        }
                        const arr = await resp.arrayBuffer();
                        const bytes = new Uint8Array(arr);
                        let binary = '';
                        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
                        const b64 = btoa(binary);
                        payload.image = b64;
                }

                // Submit to BRIA (correct v2 endpoint)
                const submitUrl = 'https://engine.prod.bria-api.com/v2/image/generate';
                const submitResp = await fetch(submitUrl, {
                        method: 'POST',
                        headers: {
                                'Content-Type': 'application/json',
                                'Api_token': c.env.BRIA_API_TOKEN,
                        },
                        body: JSON.stringify(payload),
                });

                if (!submitResp.ok) {
                        const text = await submitResp.text();
                        throw new Error(`BRIA submit failed: ${submitResp.status} - ${text}`);
                }

                const submitJson = await submitResp.json() as any;
                const statusUrl: string | undefined = submitJson?.status_url;
                if (!statusUrl) {
                        throw new Error('Missing status_url in BRIA response');
                }

                // Poll for completion
                async function pollStatus(url: string, apiToken: string, maxAttempts = 180, sleepMs = 2000): Promise<any> {
                        for (let attempt = 0; attempt < maxAttempts; attempt++) {
                                const r = await fetch(url, {
                                        headers: {
                                                'Content-Type': 'application/json',
                                                'api_token': apiToken,
                                        },
                                });
                                if (r.ok) {
                                        const data: any = await r.json();
                                        const status = String(data?.status || '').toUpperCase();
                                        if (status === 'COMPLETED') {
                                                return data?.result ?? {};
                                        }
                                        if (status === 'ERROR' || status === 'FAILED') {
                                                const errObj: any = data?.error;
                                                const msg = (typeof errObj === 'object' && errObj?.message) ? errObj.message : String(errObj || 'BRIA generation failed');
                                                throw new Error(msg);
                                        }
                                }
                                // wait
                                await new Promise((res) => setTimeout(res, sleepMs));
                        }
                        throw new Error('Timed out waiting for BRIA generation');
                }

                const result = await pollStatus(statusUrl, c.env.BRIA_API_TOKEN);
                const imageUrlOut: string | undefined = result?.image_url || result?.imageUrl;
                const structuredPromptOut: any = result?.structured_prompt ?? result?.structuredPrompt;
                const seedOut: number | undefined = result?.seed;

                if (!imageUrlOut) {
                        throw new Error('BRIA result missing image_url');
                }

                return c.json({
                        imageUrl: imageUrlOut,
                        structuredPrompt: structuredPromptOut,
                        seed: seedOut,
                });
        } catch (err) {
                console.error('Error in generate-image-with-bria:', err);
                const message = err instanceof Error ? err.message : String(err);
                return c.json({ error: message || 'Unknown error' }, 500);
        }
});
