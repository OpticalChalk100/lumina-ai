# ✨ Lumina AI — Chat & Attendance System

Lumina AI is a premium, high-performance web application that features a sophisticated chatbot powered by Hugging Face's serverless Inference Providers and a fully integrated Face Recognition Attendance System.

---

## 🚀 Live Demo

### **[👉 Click Here to Use Lumina AI Live! 👈](https://lumina-ai-iknh.onrender.com)**

> [!NOTE]
> *No account or API token is required! You can start asking questions immediately. Your Hugging Face token is securely managed on our backend server and remains 100% hidden.*

---

## 🌟 Key Features

* **Premium Glassmorphic UI**: High-fidelity dark mode with modern typography, harmonic color palettes, micro-interactions, and typing simulations.
* **Secure Token Proxy**: A secure backend server hides the developer's Hugging Face API key, protecting your credits while allowing public use.
* **Local Token Override**: Users can optionally enter their own Hugging Face token in the sidebar settings to use their own inference credits.
* **Integrated Face Recognition**: Facial verification and attendance logs with automatic CSV generation.

---

## 🛠️ Technology Stack

* **Frontend**: HTML5, Vanilla CSS3 (Custom variables, glassmorphism), JavaScript (ES Modules, Lucide icons).
* **Backend**: Node.js, Express, Cors, Native Fetch.
* **Database**: Local JSON storage & CSV append log.

---

## 🔒 Security Architecture (How the API Key is Hidden)

Lumina AI uses a secure **Backend Proxy Architecture** to protect API credentials:

```
[ Visitor's Browser ]
       │
       ▼ (1. Sends chat prompt)
[ Express Server Proxy (/api/chat) ] ──► (2. Injects private HF_TOKEN from environment)
       │
       ▼ (3. Authenticated request)
[ Hugging Face Inference Router ]
```

By routing all browser traffic through our secure backend server, your API key is **never** sent to the visitor's browser or exposed in Git history.

---

## 💻 Local Setup & Development

To clone and run this project locally:

1. Clone the repository:
   ```bash
   git clone https://github.com/OpticalChalk100/lumina-ai.git
   cd lumina-ai
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory and add your Hugging Face API token:
   ```env
   HF_TOKEN=hf_your_actual_token_here
   ```

4. Start the server:
   ```bash
   node server.js
   ```

5. Open your browser to `http://localhost:3000`.
