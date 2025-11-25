# AI Translation Studio - Frontend

React + Vite + TypeScript frontend for the AI Translation Studio application.

## Tech Stack

- **React 18** - UI library
- **Vite** - Build tool and dev server
- **TypeScript** - Type safety
- **TailwindCSS** - Styling
- **React Router** - Routing
- **Zustand** - State management
- **React Query** - Data fetching and caching
- **Axios** - HTTP client
- **Zod** - Schema validation

## Project Structure

```
frontend/
├── src/
│   ├── api/           # API client functions
│   ├── components/     # Reusable React components
│   ├── hooks/          # Custom React hooks
│   ├── pages/          # Page components
│   ├── stores/         # Zustand state stores
│   ├── types/          # TypeScript type definitions
│   ├── App.tsx         # Main app component with routing
│   ├── main.tsx        # Entry point
│   └── index.css       # Global styles
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

## Getting Started

1. Install dependencies:
```bash
npm install
```

2. Start development server:
```bash
npm run dev
```

The app will be available at `http://localhost:3000`

3. Build for production:
```bash
npm run build
```

4. Preview production build:
```bash
npm run preview
```

## API Integration

The frontend communicates with the backend API through:
- Base URL: `/api` (proxied to `http://localhost:4000` in development)
- Authentication: JWT tokens stored in Zustand store
- All API calls are defined in `src/api/` modules

## Features

- Authentication (login/logout)
- Project management
- Document viewing and editing
- Translation memory integration
- Glossary management
- Quality assurance checks
- AI translation settings



