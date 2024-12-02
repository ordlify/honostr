# Honostr

A fresh implementation of the [Nosflare](https://github.com/Spl0itable/nosflare) Nostr relay, built using [Hono](https://github.com/honojs/hono) and designed to run on Cloudflare Workers with R2 storage.

## Overview

Honostr is a Nostr relay that leverages the performance and scalability of Cloudflare Workers and R2 object storage. This project is a reimagined version of Nosflare, rewritten using the Hono web framework to provide a lightweight and efficient solution for Nostr relay implementation.

## Features

- **Cloudflare Workers Integration**: Deploys easily to Cloudflare's edge network for low-latency communication.
- **R2 Object Storage**: Utilizes Cloudflare R2 for scalable and cost-effective data storage.
- **Hono Framework**: Built with Hono, a small, simple, and ultrafast web framework for Cloudflare Workers.
- **Event Handling**: Supports all standard Nostr event types and filters.
- **Optimized Performance**: Designed for high performance and minimal resource usage.

## Getting Started

### Prerequisites

- **Node.js** (v16 or higher)
- **Package Manager**: npm, pnpm, or bun
- **Cloudflare Account** with Workers and R2 access
- **Domain** added to Cloudflare (optional, for domain-specific features)

### Installation

1. **Clone the Repository**

   ```bash
   git clone https://github.com/afxal/honostr.git
   cd honostr

   ```

2. **Install Dependencies**

   ```bash
   npm install
   ```

   or using pnpm

   ```bash
   pnpm install
   ```

3. **Configure Environment Variables**

   Create a `.env` file in the root of the project and add the following variables:

   ```bash
   AUTH_TOKEN=your_auth_token
   API_TOKEN=your_api_token
   ZONE_ID=your_zone_id
   R2_BUCKET_DOMAIN=your_r2_bucket_domain
   ACCOUNT_ID=your_account_id
   R2_BUCKET_NAME=your_bucket_name
   COMPATIBILITY_DATE=YYYY-MM-DD
   ```

   Replace the placeholders with your actual Cloudflare credentials.

4. **Build and Deploy**

   ```bash
   npm run build
   npm run deploy
   ```
