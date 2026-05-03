import { useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { Link, useLocation } from "wouter";
import { Radio, Loader2, Camera, X } from "lucide-react";
import type { CurrentUser } from "@workspace/api-zod";
import { authFetch, useAuth, API_BASE_URL } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INDIAN_LOCATIONS, INDIAN_STATES_AND_UTS } from "@/data/indianLocations";

function GoogleIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={props.className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.73 1.22 9.25 3.6l6.9-6.9C36.02 2.38 30.36 0 24 0 14.64 0 6.63 5.38 2.68 13.22l8.06 6.26C12.62 13.55 17.86 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24.5c0-1.64-.15-3.22-.42-4.75H24v9h12.7c-.55 2.92-2.19 5.39-4.64 7.05l7.1 5.5c4.15-3.84 7.34-9.5 7.34-16.8z"
      />
      <path
        fill="#FBBC05"
        d="M10.74 28.26c-.5-1.48-.78-3.06-.78-4.76s.28-3.28.78-4.76l-8.06-6.26C.92 15.47 0 19.61 0 23.5c0 3.89.92 8.03 2.68 11.52l8.06-6.76z"
      />
      <path
        fill="#34A853"
        d="M24 47c6.36 0 11.7-2.1 15.6-5.7l-7.1-5.5c-1.97 1.32-4.5 2.1-8.5 2.1-6.14 0-11.38-4.05-13.26-9.48l-8.06 6.76C6.63 41.62 14.64 47 24 47z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}

function objectUrl(path: string | null): string | undefined {
  if (!path) return undefined;
  if (path.startsWith("http")) return path;
  return `${API_BASE_URL}/storage${path}`;
}

export default function Register() {
  const { setUser } = useAuth();
  const [, navigate] = useLocation();
  const fileRef = useRef<HTMLInputElement>(null);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [state, setState] = useState("");
  const [district, setDistrict] = useState("");
  const [locality, setLocality] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isUploading, setIsUploading] = useState(false);

  async function onPhotoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setIsUploading(true);
    try {
      const ct = file.type.toLowerCase();
      const ok = ["image/jpeg", "image/png", "image/webp"].includes(ct);
      if (!ok) {
        throw new Error("Please upload a jpg, png, or webp image.");
      }
      if (file.size > 10 * 1024 * 1024) {
        throw new Error("Photo must be under 10MB.");
      }

      const fd = new FormData();
      fd.append("files", file, file.name);
      const res = await authFetch("/uploads", { method: "POST", body: fd });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Upload failed");
      }
      const data = (await res.json()) as { files: { url: string }[] };
      const url = data.files?.[0]?.url;
      if (!url) throw new Error("Upload failed");
      setPhotoUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!state.trim()) throw new Error("Please select a State/UT");
      if (!district.trim()) throw new Error("Please select a District");
      const body = {
        username: username.trim(),
        email: email.trim(),
        password,
        displayName: displayName.trim(),
        state: state.trim() || "Unknown",
        district: district.trim() || "Unknown",
        locality: locality.trim() || "Unknown",
        phoneNumber: phoneNumber.trim() || undefined,
        photoUrl: photoUrl || undefined,
      };
      const res = await authFetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Registration failed");
      }
      const user = (await res.json()) as CurrentUser;
      setUser(user);
      navigate("/verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  const photoPreview = objectUrl(photoUrl);
  const initials = (displayName || username || "U").substring(0, 2).toUpperCase();
  const districts = state ? (INDIAN_LOCATIONS[state] ?? []) : [];

  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-zinc-100 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-900/30">
            <Radio className="w-7 h-7 text-white" />
          </div>
          <span className="text-3xl font-bold tracking-tight">Khabar</span>
        </div>

        <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 sm:p-8">
          <h1 className="text-2xl font-bold mb-1">Join your locality</h1>
          <p className="text-sm text-zinc-500 mb-6">Create your account to start filing reports.</p>

          <Button
            variant="outline"
            className="w-full border-zinc-800 bg-zinc-950 hover:bg-zinc-900"
            asChild
          >
            <a
              href={`/api/auth/google?next=${encodeURIComponent("/")}`}
              data-testid="button-google-register"
            >
              <GoogleIcon className="h-5 w-5 mr-2" />
              Continue with Google
            </a>
          </Button>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-800" />
            <div className="text-xs text-zinc-500">or</div>
            <div className="h-px flex-1 bg-zinc-800" />
          </div>

          <form onSubmit={onSubmit} className="space-y-4" data-testid="form-register">
            <div className="flex items-center gap-4">
              <Avatar className="w-20 h-20 border-2 border-zinc-800">
                {photoPreview && <AvatarImage src={photoPreview} alt={displayName} />}
                <AvatarFallback className="bg-emerald-900/40 text-emerald-300 text-lg">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPhotoChange}
                  data-testid="input-photo"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                  disabled={isUploading}
                  className="border-zinc-700 bg-zinc-900 hover:bg-zinc-800"
                  data-testid="button-upload-photo"
                >
                  <Camera className="w-4 h-4 mr-2" />
                  {isUploading ? "Uploading..." : photoUrl ? "Change photo" : "Add photo"}
                </Button>
                {photoUrl && !isUploading && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-2 text-zinc-500 hover:text-rose-400"
                    onClick={() => setPhotoUrl(null)}
                  >
                    <X className="w-4 h-4 mr-1" /> Remove
                  </Button>
                )}
                <p className="text-xs text-zinc-500 mt-2">Optional. Helps neighbors trust your reports.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  required
                  minLength={3}
                  maxLength={24}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="rohan_indore"
                  className="bg-zinc-950 border-zinc-800"
                  data-testid="input-username"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="displayName">Full name</Label>
                <Input
                  id="displayName"
                  required
                  minLength={2}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Rohan Patel"
                  className="bg-zinc-950 border-zinc-800"
                  data-testid="input-display-name"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-zinc-950 border-zinc-800"
                data-testid="input-email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="bg-zinc-950 border-zinc-800"
                data-testid="input-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone number <span className="text-zinc-600 text-xs">(optional)</span></Label>
              <Input
                id="phone"
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+91 98765 43210"
                className="bg-zinc-950 border-zinc-800"
                data-testid="input-phone"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="state">State / UT</Label>
                <Select
                  value={state}
                  onValueChange={(value) => {
                    setState(value);
                    setDistrict("");
                  }}
                >
                  <SelectTrigger
                    id="state"
                    className="bg-zinc-950 border-zinc-800"
                    data-testid="select-state"
                  >
                    <SelectValue placeholder="Select a state/UT" />
                  </SelectTrigger>
                  <SelectContent>
                    {INDIAN_STATES_AND_UTS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="district">District</Label>
                <Select
                  value={district}
                  onValueChange={setDistrict}
                  disabled={!state}
                >
                  <SelectTrigger
                    id="district"
                    className="bg-zinc-950 border-zinc-800"
                    data-testid="select-district"
                  >
                    <SelectValue placeholder={state ? "Select a district" : "Select a state first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {districts.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="locality">Locality</Label>
              <Input
                id="locality"
                required
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
                placeholder="Palasia"
                className="bg-zinc-950 border-zinc-800"
                data-testid="input-locality"
              />
            </div>

            {error && (
              <div className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2" data-testid="text-error">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={submitting || isUploading}
              className="w-full bg-emerald-600 hover:bg-emerald-700"
              data-testid="button-register"
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Creating account...
                </span>
              ) : (
                "Create account"
              )}
            </Button>
          </form>

          <p className="text-sm text-zinc-500 text-center mt-6">
            Already on Khabar?{" "}
            <Link href="/login" className="text-emerald-400 hover:text-emerald-300 font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
