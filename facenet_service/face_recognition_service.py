import ssl, certifi
ssl._create_default_https_context = lambda: ssl.create_default_context(cafile=certifi.where())

from flask import Flask, request, jsonify
from facenet_pytorch import InceptionResnetV1, MTCNN
from PIL import Image
import torch
import numpy as np
import io

app = Flask(__name__)

# Global caches for lazy model loading
g_model = None
g_mtcnn = None

# Tuned MTCNN config for optimized detection
def get_mtcnn():
    global g_mtcnn
    if g_mtcnn is None:
        print("Loading MTCNN detector...")
        g_mtcnn = MTCNN(
            image_size=160,
            margin=0,
            min_face_size=40,
            keep_all=False,
            device='cpu')
        print("✅ MTCNN loaded.")
    return g_mtcnn

def get_facenet():
    global g_model
    if g_model is None:
        print("Loading InceptionResnetV1 FaceNet model... (this may take 5–10 seconds)")
        g_model = InceptionResnetV1(pretrained='vggface2').eval().cpu()
        print("✅ FaceNet model loaded.")
    return g_model

# Downscale very large images fast (PIL)
def resize_image_if_needed(img, max_len=720):
    w, h = img.size
    if max(w, h) > max_len:
        scale = max_len / float(max(w, h))
        new_size = (int(w*scale), int(h*scale))
        return img.resize(new_size, Image.Resampling.LANCZOS)
    return img

# Detect (with angle augmentation), return averaged embedding if multiple detected
def recognize_face(img):
    mtcnn = get_mtcnn()
    model = get_facenet()
    angles = [0, -15, 15]
    
    for angle in angles:
        if angle != 0:
            # Prevent expanding the canvas too much, which throws off scale
            rotated = img.rotate(angle, resample=Image.BICUBIC, expand=False)
        else:
            rotated = img
            
        face_tensor = mtcnn(rotated)
        if face_tensor is not None:
            with torch.no_grad():
                # Original
                emb = model(face_tensor.unsqueeze(0)).cpu().numpy()[0]
                # Horizontal flip augmentation for slight robustness
                flipped = torch.flip(face_tensor, dims=[2])
                emb_flip = model(flipped.unsqueeze(0)).cpu().numpy()[0]
                
            embedding_final = (emb + emb_flip) / 2.0
            # L2 Normalize
            norm = np.linalg.norm(embedding_final)
            if norm > 0:
                embedding_final = embedding_final / norm
                
            return embedding_final.tolist(), True
            
    return None, False

@app.route("/api/recognize", methods=["POST"])
def recognize():
    try:
        if 'image' not in request.files:
            return jsonify({"success": False, "embedding": [], "embedding_size": 0, "message": "No image file provided"}), 400
        image = request.files["image"]
        if image.filename == '':
            return jsonify({"success": False, "embedding": [], "embedding_size": 0, "message": "No image file selected"}), 400

        print("📸 Received image")
        try:
            from PIL import ImageOps
            img = Image.open(image.stream).convert("RGB")
            img = ImageOps.exif_transpose(img)
        except Exception as ie:
            return jsonify({"success": False, "embedding": [], "embedding_size": 0, "message": "Invalid image file"}), 400

        img = resize_image_if_needed(img, max_len=720)

        embedding, detected = recognize_face(img)
        if not detected:
            print("⚠️ No face detected")
            return jsonify({
                "success": False, "embedding": [], "embedding_size": 0, "message": "No face detected"
            }), 200  # Keep response code same for old compat
        print("✅ Face detected, generating embedding…")
        print(f"✅ Generated embedding vector of size {len(embedding)}")
        return jsonify({
            "success": True,
            "embedding": embedding,
            "embedding_size": len(embedding),
            "message": ""
        }), 200

    except Exception as e:
        print("❌ Error processing image:", str(e))
        return jsonify({
            "success": False,
            "embedding": [],
            "embedding_size": 0,
            "message": f"Error processing image: {str(e)}"
        }), 500

@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "healthy", "service": "facenet-recognition"}), 200

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5001))
    print(f"Starting FaceNet Recognition Service on port {port}…")
    # Use Flask dev server only for local dev; Render will use gunicorn entrypoint
    app.run(host="0.0.0.0", port=port, debug=False)