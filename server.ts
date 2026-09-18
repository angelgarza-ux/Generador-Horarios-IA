import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "10mb" }));

  // Helper to initialize Google GenAI SDK (gemini-3.6-flash model)
  const getGenAI = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("La clave GEMINI_API_KEY no está configurada en los secretos.");
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  };

  // API Healthcheck
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "SilverEduPro AI Server" });
  });

  // API 1: AI Generate Schedule Courses
  app.post("/api/ai/generate-schedule", async (req, res) => {
    try {
      const { prompt, days, hours } = req.body;
      if (!prompt || typeof prompt !== "string") {
        return res.status(400).json({ error: "Se requiere una descripción o prompt válido." });
      }

      const activeDaysStr = Array.isArray(days) && days.length > 0 ? days.join(", ") : "Lunes a Sábado";

      const ai = getGenAI();

      const systemInstruction = `Eres SilverEduPro AI, la inteligencia artificial especialista en diseño y planificación académica universitaria (Universidad CEU).
Tu objetivo es generar o ajustar una carga académica completa, realista y bien balanceada de materias, tetramestres, carreras, horas semanales y profesores.

REGLAS CRÍTICAS DE FORMATO Y DÍAS:
1. MANTÉN FIJO EL FORMATO Y CONFIGURACIÓN DEL USUARIO: Los días de clase activos configurados son exclusivamente: [${activeDaysStr}]. NO modifiques el formato de las carreras ni borres la estructura especificada por el usuario.
2. Si varias carreras comparten la misma materia con el mismo profesor (ej. "IME IIA IMA"), colócalas en el mismo campo 'carreras' separado por espacios.
3. Asigna horas semanales adecuadas a los días activos (por ejemplo, si sólo está habilitado el Sábado, ajusta las horas semanales para repartir entre la jornada sabatina de ${hours?.length || 8} horas disponibles).
4. Asigna nombres de profesores realistas o utiliza los proporcionados por el usuario.`;

      const userPrompt = `Solicitud del usuario: "${prompt}"
Días activos de clase permitidos: ${JSON.stringify(days || ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'])}
Horas/Franjas por día: ${hours?.length || 8} franjas horarias (${hours ? hours.slice(0, 3).join(', ') + '...' : '07:00 a 15:00'}).

Genera la lista de materias estructurada respetando exactamente el esquema JSON solicitado.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: userPrompt,
        config: {
          systemInstruction,
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: "Resumen explicativo de la estructuración realizada por la IA.",
              },
              courses: {
                type: Type.ARRAY,
                description: "Lista de materias generadas con sus docentes y carreras.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    tetra: { type: Type.STRING, description: "Número de tetramestre/cuatrimestre, ej: '1°', '3°', '5°'" },
                    carreras: { type: Type.STRING, description: "Siglas de carreras separadas por espacio, ej: 'IME IIA IMT'" },
                    materia: { type: Type.STRING, description: "Nombre completo de la materia en mayúsculas" },
                    horasSemana: { type: Type.INTEGER, description: "Cantidad de horas lectivas semanales (2 a 6)" },
                    profesor: { type: Type.STRING, description: "Nombre y apellido del docente asignado" },
                  },
                  required: ["tetra", "carreras", "materia", "horasSemana", "profesor"],
                },
              },
            },
            required: ["summary", "courses"],
          },
        },
      });

      const resultText = response.text || "{}";
      const parsedData = JSON.parse(resultText);

      return res.json({
        success: true,
        summary: parsedData.summary || "Carga académica generada exitosamente con Gemini 3.6 Flash.",
        courses: parsedData.courses || [],
      });
    } catch (err: any) {
      console.error("Error en /api/ai/generate-schedule:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Error al procesar la solicitud con Gemini AI.",
      });
    }
  });

  // API 2: AI Optimize Existing Schedule & Resolve Conflicts
  app.post("/api/ai/optimize-schedule", async (req, res) => {
    try {
      const { courses, teacherUnavailability, instructions, days, hours } = req.body;
      if (!Array.isArray(courses) || courses.length === 0) {
        return res.status(400).json({ error: "Se requiere una lista de materias no vacía para optimizar." });
      }

      const activeDaysStr = Array.isArray(days) && days.length > 0 ? days.join(", ") : "Días configurados";

      const ai = getGenAI();

      const systemInstruction = `Eres el Optimizador Pedagógico e IA de SilverEduPro.
Tu trabajo es revisar una lista existente de materias, docentes y restricciones de horarios.
MANTÉN FIJO Y SIN ALTERAR EL FORMATO DEL USUARIO Y LOS DÍAS ACTIVOS [${activeDaysStr}].
Debes:
1. No alterar los nombres de las materias ni cambiar el formato de carreras excepto si se pide explícitamente.
2. Identificar si hay docentes sobrecargados o asignados a demasiadas materias.
3. Agrupar materias idénticas impartidas por el mismo profesor en múltiples carreras para optimizar el uso de aulas.
4. Devolver la lista optimizada mejorada respetando el número exacto de carreras y profesores dados.`;

      const promptContext = `Lista de materias actual (${courses.length} materias):
${JSON.stringify(courses, null, 2)}

Indisponibilidad de Docentes:
${JSON.stringify(teacherUnavailability || {}, null, 2)}

Instrucciones adicionales del usuario: "${instructions || 'Optimizar distribución de docentes y evitar sobrecargas'}"

Devuelve la lista optimizada de materias manteniendo o mejorando la calidad del plan académico.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: promptContext,
        config: {
          systemInstruction,
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              recommendations: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Lista de recomendaciones pedagógicas y mejoras aplicadas por la IA.",
              },
              optimizedCourses: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    tetra: { type: Type.STRING },
                    carreras: { type: Type.STRING },
                    materia: { type: Type.STRING },
                    horasSemana: { type: Type.INTEGER },
                    profesor: { type: Type.STRING },
                  },
                  required: ["tetra", "carreras", "materia", "horasSemana", "profesor"],
                },
              },
            },
            required: ["recommendations", "optimizedCourses"],
          },
        },
      });

      const parsed = JSON.parse(response.text || "{}");

      return res.json({
        success: true,
        recommendations: parsed.recommendations || ["Distribución revisada por la IA."],
        courses: parsed.optimizedCourses || courses,
      });
    } catch (err: any) {
      console.error("Error en /api/ai/optimize-schedule:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Error al optimizar horario con Gemini AI.",
      });
    }
  });

  // Vite middleware for development vs static serve for production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
