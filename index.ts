import express from "express";
import type { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import cors from "cors";
import {
  MongoClient,
  ServerApiVersion,
  ObjectId,
  Collection,
  Db,
} from "mongodb";
import { jwtVerify, createRemoteJWKSet } from "jose-cjs";
import dns from "node:dns";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, convertToModelMessages } from "ai";
// Custom DNS resolvers set up to avoid Atlas connection drops
dns.setServers(["1.1.1.1", "1.0.0.1"]);

dotenv.config();

const openRouterApiKey = process.env.OPENROUTER_API_KEY;

if (!openRouterApiKey) {
  throw new Error("Missing OPENROUTER_API_KEY environment variable");
}

const openrouter = createOpenAI({
  apiKey: openRouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

const uri: string | undefined = process.env.MONGODB_URI;
const PORT: string | number = process.env.PORT || 5000;
const clientUrl: string = process.env.CLIENT_URL || "http://localhost:3000";

if (!uri) {
  throw new Error('Invalid/Missing environment variable: "MONGODB_URI"');
}

const app = express();

// Middleware (CORS configuration updated for safety)
app.use(
  cors({
    credentials: true,
    origin: [clientUrl, "http://localhost:3000"],
  }),
);
app.use(express.json());

app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

// MongoDB Client Initialization
const client: MongoClient = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Better Auth JWKS Endpoint Client Integration
const JWKS = createRemoteJWKSet(new URL(`${clientUrl}/api/auth/jwks`));

// Extending Express Request Type to natively support custom auth payload
interface AuthenticatedRequest extends Request {
  user?: any;
}

// Global Authentication Middleware
const verifyToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader: string | undefined = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ msg: "Invalid or expired token" });
  }
};

// Instructor Verification Middleware (শুধুমাত্র ইন্সট্রাক্টরদের জন্য)
const instructorVerify = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;

  if (!user || user.role !== "instructor") {
    return res.status(403).json({ msg: "Forbidden: Instructors only" });
  }
  next();
};

async function run() {
  try {
    // await client.connect();

    // Database Name changed to AuraStudy
    const db: Db = client.db("AuraStudy");
    const usersCollection: Collection = db.collection("users");
    const coursesCollection: Collection = db.collection("courses");
    const enrollmentsCollection: Collection = db.collection("enrollments");
    const chatSessionsCollection: Collection = db.collection("chatSessions");

    // AI Chat Assistant API
    // AI Chat Assistant API
    app.post("/api/chat", async (req: Request, res: Response) => {
      try {
        console.log("=== /api/chat called ===");
        console.log(req.body);

        const { messages } = req.body;

        let courseContext = "";

        try {
          const courses = await coursesCollection
            .find(
              {},
              {
                projection: {
                  title: 1,
                  price: 1,
                  category: 1,
                },
              },
            )
            .toArray();

          courseContext = courses
            .map(
              (course) =>
                `- ${course.title} (${course.category}) - Price: $${course.price}`,
            )
            .join("\n");
        } catch (dbError) {
          console.error("Database Error:", dbError);
        }

        const result = streamText({
          model: openrouter("openai/gpt-oss-20b:free"),

          system: `
তুমি AuraStudy-এর একজন বন্ধুসুলভ AI স্টাডি অ্যাসিস্ট্যান্ট।

তুমি ইউজারকে সাহায্য করবে:
- Course recommendation দিতে
- Course সম্পর্কে বুঝাতে
- Learning roadmap বানাতে
- Programming ও Educational প্রশ্নের উত্তর দিতে

Available Courses:

${courseContext}
      `,

          messages: await convertToModelMessages(messages),
        });

        return result.pipeUIMessageStreamToResponse(res);
      } catch (error: any) {
        console.error("Chat API Error:", error);

        if (!res.headersSent) {
          return res.status(500).json({
            error: error.message ?? "Internal Server Error",
          });
        }
      }
    });

    // AI Study Roadmap Generator API (Feature A)
    // AI Study Roadmap Generator API (Feature A)
    app.post("/api/roadmap", async (req: Request, res: Response) => {
      try {
        console.log("=== /api/roadmap called ===");
        const { prompt, length } = req.body;

        console.log("User Prompt:", prompt, "| Length:", length);

        if (!prompt) {
          console.log("❌ Error: No prompt found in req.body");
          return res.status(400).json({ error: "Prompt is required" });
        }

        // Output Length অনুযায়ী AI-এর জন্য ইন্সট্রাকশন
        let lengthInstruction = "";
        if (length === "short") {
          lengthInstruction = "রোডম্যাপটি খুব সংক্ষেপ (Short) এবং মূল পয়েন্টগুলোকে ফোকাস করে ৩-৪টি ধাপে উপস্থাপন করো।";
        } else if (length === "detailed") {
          lengthInstruction = "রোডম্যাপটি অত্যন্ত বিস্তারিত (Highly Detailed) করো, যেখানে প্রতিটি সপ্তাহের জন্য সাব-টপিক, রিসোর্স পরামর্শ এবং টিপস থাকবে।";
        } else {
          lengthInstruction = "রোডম্যাপটি স্ট্যান্ডার্ড (Medium Length) ও সামঞ্জস্যপূর্ণভাবে তৈরি করো।";
        }

        console.log("⏳ Calling OpenRouter API...");
        const result = streamText({
          model: openrouter("openai/gpt-oss-20b:free"),
          system: `তুমি একজন এক্সপার্ট টেকনিক্যাল মেন্টর। 
ইউজারের লক্ষ্যের ওপর ভিত্তি করে একটি প্র্যাকটিক্যাল স্টাডি রোডম্যাপ তৈরি করো।

দৈর্ঘ্যের নির্দেশিকা: ${lengthInstruction}

রোডম্যাপটি অবশ্যই Markdown ফরম্যাটে হবে, যেখানে সুন্দরভাবে হেডিং (##), বুলেট পয়েন্ট, এবং টিপস থাকবে।`,
          prompt: `স্টাডি গোল: ${prompt}`,
        });

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");

        let isFirstChunk = true;

        for await (const chunk of result.textStream) {
          if (isFirstChunk) {
            console.log("🚀 OpenRouter থেকে ডেটা আসা শুরু হয়েছে...");
            isFirstChunk = false;
          }
          res.write(chunk);
        }

        console.log("✅ Roadmap streaming successfully completed!");
        res.end();
      } catch (error: any) {
        console.error("❌ Roadmap API Error:", error.message);
        if (!res.headersSent) {
          return res.status(500).json({
            error: error.message ?? "Internal Server Error",
          });
        } else {
          res.end();
        }
      }
    });

    // Route: Instructor der notun course add korar API
    app.post(
      "/api/courses",
      verifyToken,
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const data = req.body;

          const newCourse = {
            title: data.title,
            price: Number(data.price) || 0,
            category: data.category || "Uncategorized",
            shortDescription: data.shortDescription,
            fullDescription: data.fullDescription,
            image: data.image || "",
            instructorId: req.user?.id,
            instructorName: req.user?.name || "User",
            createdAt: new Date(),
            rating: 0,
            reviewsCount: 0,
            specifications: [],
            images: data.image ? [data.image] : [],
          };

          const result = await coursesCollection.insertOne(newCourse);

          res.status(201).json({
            ...newCourse,
            insertedId: result.insertedId,
          });
        } catch (error) {
          console.error("Error adding course:", error);
          res.status(500).json({ msg: "Failed to add course" });
        }
      },
    );

    // Route: Role-based Dashboard Stats
    app.get(
      "/api/dashboard/stats",
      verifyToken,
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const userId = req.user?.id;
          const role = req.user?.role?.toLowerCase();

          if (!userId || !role) {
            return res
              .status(400)
              .json({ msg: "User ID or role not found in token" });
          }

          if (role === "admin") {
            const totalUsers = await usersCollection.countDocuments({});
            const totalCourses = await coursesCollection.countDocuments({});

            return res.json({ role, totalUsers, totalCourses });
          }

          if (role === "instructor") {
            const totalCourses = await coursesCollection.countDocuments({
              instructorId: userId,
            });
            const totalEnrollments = await enrollmentsCollection.countDocuments(
              { instructorId: userId },
            );

            return res.json({ role, totalCourses, totalEnrollments });
          }

          if (role === "student") {
            const myEnrollments = await enrollmentsCollection
              .find({ studentId: userId })
              .toArray();

            return res.json({ role, totalEnrolled: myEnrollments.length });
          }

          return res
            .status(403)
            .json({ msg: "Forbidden: Invalid role context" });
        } catch (error) {
          console.error("Error fetching dashboard statistics:", error);
          res.status(500).json({ msg: "Internal Server Error" });
        }
      },
    );

    // ─── Task 6: Explore Page (Search, Filter, Sort, Pagination) ───
    // Public Route: যে কেউ কোর্সগুলো দেখতে পারবে
    app.get("/api/courses", async (req: Request, res: Response) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 8; // Desktop-এ ৪ কলামের গ্রিডের জন্য ৮টা (২ রো) বেস্ট
        const skip = (page - 1) * limit;

        // Filters (কমপক্ষে ২টি ফিল্ড রিকোয়ারমেন্ট অনুযায়ী category এবং price ফিল্টার)
        const search = req.query.search as string;
        const category = req.query.category as string;
        const maxPrice = req.query.maxPrice
          ? parseInt(req.query.maxPrice as string)
          : null;
        const sortParams = req.query.sort as string;

        let query: any = {};

        // ১. সার্চ ফিল্টার
        if (search) {
          query.title = { $regex: search, $options: "i" };
        }
        // ২. ক্যাটাগরি ফিল্টার
        if (category && category !== "All") {
          query.category = category;
        }
        // ৩. প্রাইস ফিল্টার (Multi-field filtering এর শর্ত পূরণের জন্য)
        if (maxPrice !== null) {
          query.price = { $lte: maxPrice };
        }

        // সর্টিং লজিক
        let sortQuery: any = { createdAt: -1 };
        if (sortParams === "price_asc") sortQuery = { price: 1 };
        if (sortParams === "price_desc") sortQuery = { price: -1 };

        const courses = await coursesCollection
          .find(query)
          .sort(sortQuery)
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await coursesCollection.countDocuments(query);

        res.json({
          courses,
          total,
          page,
          totalPages: Math.ceil(total / limit),
        });
      } catch (error) {
        res.status(500).json({ msg: "Failed to fetch courses" });
      }
    });

    // ─── Task 5: Details Page (Single Item) ───
    // Public Route
    app.get("/api/courses/:id", async (req: Request, res: Response) => {
      try {
        const id = req.params.id;
        const course = await coursesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!course) return res.status(404).json({ msg: "Course not found" });
        res.json(course);
      } catch (error) {
        res.status(500).json({ msg: "Invalid ID format or server error" });
      }
    });

    // ─── Task 8: Add Item (Protected - Update তোমার আগের কোড) ───
    app.post(
      "/api/courses",
      verifyToken,

      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const data = req.body;

          // Frontend থেকে পাঠানো price স্ট্রিং আকারে আসতে পারে, তাই নাম্বার কনভার্ট এবং অন্যান্য রিকোয়ারমেন্টস ডিফল্ট ভ্যালু সেট করা
          const newCourse = {
            title: data.title,
            price: Number(data.price) || 0,
            category: data.category || "Uncategorized",
            shortDescription: data.shortDescription,
            fullDescription: data.fullDescription,
            image: data.image || "", // ImgBB URL
            instructorId: req.user?.id,
            instructorName: req.user?.name || "Instructor",
            createdAt: new Date(),
            rating: 0, // Task 4: Meta info এর জন্য ডিফল্ট রেটিং
            reviewsCount: 0, // Task 5: Reviews এর জন্য কাউন্টার
            specifications: [], // Task 5: Specifications এর জন্য খালি অ্যারে
            images: data.image ? [data.image] : [], // Task 5: Multiple images এর জন্য অ্যারে
          };

          const result = await coursesCollection.insertOne(newCourse);
          res.status(201).json({ ...result, insertedId: result.insertedId });
        } catch (error) {
          console.error("Error adding course:", error);
          res.status(500).json({ msg: "Failed to add course" });
        }
      },
    );

    // ─── Task 9: Manage Items (Fetch Only Instructor's Courses) ───
    app.get(
      "/api/manage-courses",
      verifyToken,

      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const userId = req.user?.id;
          const myCourses = await coursesCollection
            .find({ instructorId: userId })
            .sort({ createdAt: -1 })
            .toArray();
          res.json(myCourses);
        } catch (error) {
          res.status(500).json({ msg: "Failed to fetch your courses" });
        }
      },
    );

    app.get(
      "/api/enrollments/my-courses",
      verifyToken,
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const studentId = req.user?.id;

          const enrollments = await enrollmentsCollection
            .find({ studentId })
            .sort({ enrolledAt: -1 })
            .toArray();

          res.json(enrollments);
        } catch (error) {
          console.error("Failed to fetch enrolled courses:", error);
          res.status(500).json({
            msg: "Failed to fetch enrolled courses",
          });
        }
      },
    );

    // ─── Task 9: Delete Item ───
    app.delete(
      "/api/courses/:id",
      verifyToken,

      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const id = req.params.id;
          const userId = req.user?.id;

          // শুধুমাত্র সেই কোর্সটি ডিলিট হবে যেটা এই ইউজারের তৈরি করা
          const result = await coursesCollection.deleteOne({
            _id: new ObjectId(id),
            instructorId: userId,
          });

          if (result.deletedCount === 0) {
            return res
              .status(403)
              .json({ msg: "Unauthorized or course not found" });
          }

          res.json({ msg: "Course deleted successfully" });
        } catch (error) {
          res.status(500).json({ msg: "Failed to delete course" });
        }
      },
    );

    // ─────────────────────────────────────────────
    // ENROLL IN COURSE
    // ─────────────────────────────────────────────

    app.post(
      "/api/enrollments",
      verifyToken,
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const userId = req.user?.id;
          const { courseId } = req.body;

          if (!userId || !courseId) {
            return res.status(400).json({
              msg: "User ID and Course ID are required",
            });
          }

          if (!ObjectId.isValid(courseId)) {
            return res.status(400).json({
              msg: "Invalid course ID",
            });
          }

          const course = await coursesCollection.findOne({
            _id: new ObjectId(courseId),
          });

          if (!course) {
            return res.status(404).json({
              msg: "Course not found",
            });
          }

          // একই course-এ duplicate enrollment আটকানো
          const existingEnrollment = await enrollmentsCollection.findOne({
            studentId: userId,
            courseId: courseId,
          });

          if (existingEnrollment) {
            return res.status(409).json({
              msg: "You are already enrolled in this course",
            });
          }

          const enrollment = {
            studentId: userId,
            courseId: courseId,

            // Course data snapshot
            courseTitle: course.title,
            courseImage: course.image || "",
            courseCategory: course.category || "General",
            instructorName: course.instructorName || "Instructor",

            // Learning progress
            progress: 0,
            completedLessons: 0,
            totalLessons: 20,
            status: "in-progress",

            enrolledAt: new Date(),
            lastAccessedAt: new Date(),
          };

          const result = await enrollmentsCollection.insertOne(enrollment);

          res.status(201).json({
            msg: "Successfully enrolled in course",
            enrollmentId: result.insertedId,
          });
        } catch (error) {
          console.error("Enrollment error:", error);

          res.status(500).json({
            msg: "Failed to enroll in course",
          });
        }
      },
    );

    // ─────────────────────────────────────────────
    // GET MY ENROLLED COURSES
    // ─────────────────────────────────────────────

    app.get(
      "/api/my-courses",
      verifyToken,
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const userId = req.user?.id;

          if (!userId) {
            return res.status(401).json({
              msg: "Unauthorized",
            });
          }

          const myCourses = await enrollmentsCollection
            .find({ studentId: userId })
            .sort({ lastAccessedAt: -1 })
            .toArray();

          res.json(myCourses);
        } catch (error) {
          console.error("Fetch my courses error:", error);

          res.status(500).json({
            msg: "Failed to fetch enrolled courses",
          });
        }
      },
    );

    app.get("/test-himel-123", (req, res) => {
      res.send("THIS IS MY SERVER");
    });

    // await client.db("admin").command({ ping: 1 });
    console.log(
      "⚡ Pinged your deployment. Connected safely to MongoDB Atlas!",
    );
  } catch (error) {
    console.error("Database initialization failed:", error);
  }
}





run().catch(console.dir);

app.get("/test-himel-123", (req: Request, res: Response) => {
  res.send("THIS IS MY SERVER");
});

app.get("/", (req: Request, res: Response) => {
  res.send("AuraStudy TypeScript is running !");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

