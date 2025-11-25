# AI Translation Studio V2

A professional-grade web-based translation environment with AI orchestration, translation memory, and quality assurance.

## Prerequisites

- **Node.js** (v18 or higher)
- **PostgreSQL** (v14 or higher)
- **npm** or **yarn**

## Quick Start

### 1. Clone and Install Dependencies

```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 2. Database Setup

#### Option A: Using PostgreSQL (Recommended)

1. Create a PostgreSQL database:
```bash
# Using psql
createdb ai_translation_studio

# Or using SQL
psql -U postgres
CREATE DATABASE ai_translation_studio;
```

2. Set up the database connection string in your `.env` file (see step 3).

#### Option B: Using Docker

```bash
docker run --name ai-translation-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=ai_translation_studio \
  -p 5432:5432 \
  -d postgres:14
```

### 3. Configure Environment Variables

Create a `.env` file in the `backend` directory:

```bash
cd backend
cp .env.example .env  # If you have an example file
# Or create .env manually
```

**Required environment variables:**

```env
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/ai_translation_studio"

# JWT Secret (use a strong random string in production)
JWT_SECRET="your-super-secret-jwt-key-change-this-in-production"

# Server
PORT=4000
NODE_ENV=development

# File Storage
FILE_STORAGE_DIR="./storage"

# AI Providers (Optional - for AI translation features)
OPENAI_API_KEY="your-openai-api-key"
GEMINI_API_KEY="your-google-gemini-api-key"
YANDEX_API_KEY="your-yandex-api-key"
YANDEX_FOLDER_ID="your-yandex-folder-id"  # Required for YandexGPT (get from Yandex Cloud console)

# AI Configuration (Optional)
DEFAULT_AI_PROVIDER="gemini"
AI_BATCH_SIZE=20
AI_MAX_RETRIES=3
```

### 4. Run Database Migrations

```bash
cd backend

# Generate Prisma Client
npm run prisma:generate

# Run migrations
npx prisma migrate dev

# (Optional) Seed database with initial data
# npx prisma db seed
```

### 5. Start the Backend Server

```bash
cd backend

# Development mode (with hot reload)
npm run dev

# Or production mode
npm run build
npm start
```

The backend will start on `http://localhost:4000`

### 6. Start the Frontend Development Server

Open a new terminal:

```bash
cd frontend

# Start development server
npm run dev
```

The frontend will start on `http://localhost:3000`

### 7. Access the Application

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:4000/api

## First Time Setup

### Create Your First User

You can register a user through the frontend at `/login`, or use the API:

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "password123",
    "name": "Admin User",
    "role": "ADMIN"
  }'
```

**Available roles:**
- `ADMIN` - Full system access
- `PROJECT_MANAGER` - Can manage projects
- `LINGUIST` - Can translate documents

## Development Scripts

### Backend

```bash
cd backend

npm run dev          # Start development server with hot reload
npm run build        # Build for production
npm start            # Run production build
npm run prisma:generate  # Generate Prisma Client
npx prisma studio    # Open Prisma Studio (database GUI)
```

### Frontend

```bash
cd frontend

npm run dev          # Start development server
npm run build        # Build for production
npm run preview      # Preview production build
npm run lint         # Run linter
```

## Project Structure

```
ai-translation-studio/
├── backend/          # Node.js + Express API
│   ├── src/
│   │   ├── routes/   # API routes
│   │   ├── services/ # Business logic
│   │   ├── ai/       # AI orchestration
│   │   └── utils/    # Utilities
│   └── prisma/       # Database schema & migrations
│
├── frontend/         # React + Vite frontend
│   └── src/
│       ├── pages/    # Page components
│       ├── components/ # Reusable components
│       ├── api/      # API client
│       └── hooks/    # Custom React hooks
│
└── storage/         # File storage directory
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

### Projects
- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id` - Get project
- `PATCH /api/projects/:id` - Update project
- `DELETE /api/projects/:id` - Delete project

### Documents
- `GET /api/documents` - List documents
- `POST /api/documents/upload` - Upload document
- `GET /api/documents/:id` - Get document
- `GET /api/documents/:id/download` - Download document

### Translation Editor
- `GET /api/segments/document/:documentId` - Get segments
- `PATCH /api/segments/:id` - Update segment
- `POST /api/segments/:id/mt` - Machine translate segment

### Translation Memory
- `GET /api/tm/search` - Search TM
- `POST /api/tm/add` - Add TM entry
- `POST /api/tm/import-tmx` - Import TMX file

### Reports
- `GET /api/reports/projects` - Get projects overview
- `GET /api/reports/projects/:id` - Get project report
- `GET /api/reports/users/:id` - Get user report

## Troubleshooting

### Database Connection Issues

1. Verify PostgreSQL is running:
```bash
# Windows
net start postgresql-x64-14

# Linux/Mac
sudo systemctl status postgresql
```

2. Check DATABASE_URL format:
```
postgresql://username:password@host:port/database
```

3. Test connection:
```bash
psql $DATABASE_URL
```

### Port Already in Use

If port 4000 or 3000 is already in use:

- Backend: Change `PORT` in `.env` file
- Frontend: Change port in `vite.config.ts` or use `npm run dev -- --port 3001`

### Prisma Issues

```bash
# Reset database (WARNING: deletes all data)
npx prisma migrate reset

# Generate Prisma Client
npm run prisma:generate

# View database in Prisma Studio
npx prisma studio
```

### Frontend Build Issues

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Clear Vite cache
rm -rf node_modules/.vite
```

## Production Deployment

### Backend

1. Build the application:
```bash
cd backend
npm run build
```

2. Set production environment variables
3. Run migrations:
```bash
npx prisma migrate deploy
```

4. Start with PM2 or similar:
```bash
npm install -g pm2
pm2 start dist/server.js --name ai-translation-backend
```

### Frontend

1. Build for production:
```bash
cd frontend
npm run build
```

2. Serve the `dist` folder with a web server (nginx, Apache, etc.)

## Support

For issues or questions, please check:
- Backend logs in console
- Frontend browser console
- Database connection status
- Environment variables configuration




A professional-grade web-based translation environment with AI orchestration, translation memory, and quality assurance.

## Prerequisites

- **Node.js** (v18 or higher)
- **PostgreSQL** (v14 or higher)
- **npm** or **yarn**

## Quick Start

### 1. Clone and Install Dependencies

```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 2. Database Setup

#### Option A: Using PostgreSQL (Recommended)

1. Create a PostgreSQL database:
```bash
# Using psql
createdb ai_translation_studio

# Or using SQL
psql -U postgres
CREATE DATABASE ai_translation_studio;
```

2. Set up the database connection string in your `.env` file (see step 3).

#### Option B: Using Docker

```bash
docker run --name ai-translation-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=ai_translation_studio \
  -p 5432:5432 \
  -d postgres:14
```

### 3. Configure Environment Variables

Create a `.env` file in the `backend` directory:

```bash
cd backend
cp .env.example .env  # If you have an example file
# Or create .env manually
```

**Required environment variables:**

```env
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/ai_translation_studio"

# JWT Secret (use a strong random string in production)
JWT_SECRET="your-super-secret-jwt-key-change-this-in-production"

# Server
PORT=4000
NODE_ENV=development

# File Storage
FILE_STORAGE_DIR="./storage"

# AI Providers (Optional - for AI translation features)
OPENAI_API_KEY="your-openai-api-key"
GEMINI_API_KEY="your-google-gemini-api-key"
YANDEX_API_KEY="your-yandex-api-key"
YANDEX_FOLDER_ID="your-yandex-folder-id"  # Required for YandexGPT (get from Yandex Cloud console)

# AI Configuration (Optional)
DEFAULT_AI_PROVIDER="gemini"
AI_BATCH_SIZE=20
AI_MAX_RETRIES=3
```

### 4. Run Database Migrations

```bash
cd backend

# Generate Prisma Client
npm run prisma:generate

# Run migrations
npx prisma migrate dev

# (Optional) Seed database with initial data
# npx prisma db seed
```

### 5. Start the Backend Server

```bash
cd backend

# Development mode (with hot reload)
npm run dev

# Or production mode
npm run build
npm start
```

The backend will start on `http://localhost:4000`

### 6. Start the Frontend Development Server

Open a new terminal:

```bash
cd frontend

# Start development server
npm run dev
```

The frontend will start on `http://localhost:3000`

### 7. Access the Application

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:4000/api

## First Time Setup

### Create Your First User

You can register a user through the frontend at `/login`, or use the API:

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "password123",
    "name": "Admin User",
    "role": "ADMIN"
  }'
```

**Available roles:**
- `ADMIN` - Full system access
- `PROJECT_MANAGER` - Can manage projects
- `LINGUIST` - Can translate documents

## Development Scripts

### Backend

```bash
cd backend

npm run dev          # Start development server with hot reload
npm run build        # Build for production
npm start            # Run production build
npm run prisma:generate  # Generate Prisma Client
npx prisma studio    # Open Prisma Studio (database GUI)
```

### Frontend

```bash
cd frontend

npm run dev          # Start development server
npm run build        # Build for production
npm run preview      # Preview production build
npm run lint         # Run linter
```

## Project Structure

```
ai-translation-studio/
├── backend/          # Node.js + Express API
│   ├── src/
│   │   ├── routes/   # API routes
│   │   ├── services/ # Business logic
│   │   ├── ai/       # AI orchestration
│   │   └── utils/    # Utilities
│   └── prisma/       # Database schema & migrations
│
├── frontend/         # React + Vite frontend
│   └── src/
│       ├── pages/    # Page components
│       ├── components/ # Reusable components
│       ├── api/      # API client
│       └── hooks/    # Custom React hooks
│
└── storage/         # File storage directory
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

### Projects
- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id` - Get project
- `PATCH /api/projects/:id` - Update project
- `DELETE /api/projects/:id` - Delete project

### Documents
- `GET /api/documents` - List documents
- `POST /api/documents/upload` - Upload document
- `GET /api/documents/:id` - Get document
- `GET /api/documents/:id/download` - Download document

### Translation Editor
- `GET /api/segments/document/:documentId` - Get segments
- `PATCH /api/segments/:id` - Update segment
- `POST /api/segments/:id/mt` - Machine translate segment

### Translation Memory
- `GET /api/tm/search` - Search TM
- `POST /api/tm/add` - Add TM entry
- `POST /api/tm/import-tmx` - Import TMX file

### Reports
- `GET /api/reports/projects` - Get projects overview
- `GET /api/reports/projects/:id` - Get project report
- `GET /api/reports/users/:id` - Get user report

## Troubleshooting

### Database Connection Issues

1. Verify PostgreSQL is running:
```bash
# Windows
net start postgresql-x64-14

# Linux/Mac
sudo systemctl status postgresql
```

2. Check DATABASE_URL format:
```
postgresql://username:password@host:port/database
```

3. Test connection:
```bash
psql $DATABASE_URL
```

### Port Already in Use

If port 4000 or 3000 is already in use:

- Backend: Change `PORT` in `.env` file
- Frontend: Change port in `vite.config.ts` or use `npm run dev -- --port 3001`

### Prisma Issues

```bash
# Reset database (WARNING: deletes all data)
npx prisma migrate reset

# Generate Prisma Client
npm run prisma:generate

# View database in Prisma Studio
npx prisma studio
```

### Frontend Build Issues

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Clear Vite cache
rm -rf node_modules/.vite
```

## Production Deployment

### Backend

1. Build the application:
```bash
cd backend
npm run build
```

2. Set production environment variables
3. Run migrations:
```bash
npx prisma migrate deploy
```

4. Start with PM2 or similar:
```bash
npm install -g pm2
pm2 start dist/server.js --name ai-translation-backend
```

### Frontend

1. Build for production:
```bash
cd frontend
npm run build
```

2. Serve the `dist` folder with a web server (nginx, Apache, etc.)

## Support

For issues or questions, please check:
- Backend logs in console
- Frontend browser console
- Database connection status
- Environment variables configuration








