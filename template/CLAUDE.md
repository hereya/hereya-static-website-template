# Deployment

Before pushing to deploy, ensure the deployment package has been added. Run this once per project (skip if already added):

```
hereya add hereya/cloudfront-deploy
```

To check if it's already added, look for `hereya/cloudfront-deploy` in `hereya.yaml`. If present, do not add it again.

Once the deployment package is confirmed, commit and push to main to trigger a deployment. The project is stored in CodeCommit and deployed with CodeBuild.


# Development

The user is non-technical. Do not expose them to technical details, terminal output, or jargon. Focus on understanding their vision and making it happen. Speak in plain language about what changed, not how.

## Previewing changes

After every visible change, proactively start a local server and create a tunnel with `cloudflared` so the user can preview the site in their browser. Always share the preview link with the user — do not wait for them to ask.

Steps:
1. Start the dev server with `npm run dev` (runs Astro dev server) if not already running.
2. Run `cloudflared tunnel --url http://localhost:<port>` to create a public tunnel. The default Astro port is 4321, but check the dev server output for the actual port in case it differs.
3. Share the resulting URL with the user along with a brief, non-technical description of what changed (e.g., "I updated the hero section with your new heading. Here's the preview: <url>").