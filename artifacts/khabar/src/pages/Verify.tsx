import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Radio, Loader2, Mail, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch, useAuth } from "@/lib/auth";
import { toast } from "sonner";

type Channel = "email" | "phone";

export default function Verify() {
  const { user, refresh } = useAuth();
  const [, navigate] = useLocation();

  const requiresPhone = !!user?.phoneNumber;
  const done = !!user?.isEmailVerified && (!requiresPhone || !!user?.isPhoneVerified);

  const [sending, setSending] = useState<Channel | null>(null);
  const [verifying, setVerifying] = useState<Channel | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const steps = useMemo(() => {
    const list: { channel: Channel; title: string; icon: ReactNode }[] = [
      { channel: "email", title: "Verify your email", icon: <Mail className="w-4 h-4" /> },
    ];
    if (requiresPhone) {
      list.push({ channel: "phone", title: "Verify your phone", icon: <Phone className="w-4 h-4" /> });
    }
    return list;
  }, [requiresPhone]);

  if (!user) {
    // AuthGate will redirect to login
    return null;
  }

  if (done) {
    // Verified users should not sit on this page
    navigate("/");
    return null;
  }

  async function requestOtp(channel: Channel) {
    setError(null);
    setSending(channel);
    try {
      const res = await authFetch("/auth/verify/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to send OTP");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send OTP";
      setError(msg);
      toast.error(msg);
    } finally {
      setSending(null);
    }
  }

  async function confirmOtp(channel: Channel, code: string) {
    setError(null);
    setVerifying(channel);
    try {
      const res = await authFetch("/auth/verify/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, code }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Verification failed");
      }
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Verification failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setVerifying(null);
    }
  }

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
          <h1 className="text-2xl font-bold mb-1">Verify your account</h1>

          <div className="space-y-6">
            {steps.map((s) => {
              const isVerified =
                s.channel === "email" ? user.isEmailVerified : user.isPhoneVerified;
              const code = s.channel === "email" ? emailCode : phoneCode;
              const setCode = s.channel === "email" ? setEmailCode : setPhoneCode;
              const destination =
                s.channel === "email" ? user.email : user.phoneNumber ?? "";
              return (
                <div key={s.channel} className="border border-zinc-800 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 font-semibold">
                        {s.icon}
                        {s.title}
                      </div>
                      <div className="text-xs text-zinc-500 mt-1">
                        {destination}
                      </div>
                    </div>
                    {isVerified ? (
                      <div className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-1 rounded-md">
                        Verified
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="border-zinc-800 bg-zinc-950 hover:bg-zinc-900"
                        disabled={sending !== null}
                        onClick={() => void requestOtp(s.channel)}
                        data-testid={`button-send-${s.channel}`}
                      >
                        {sending === s.channel ? (
                          <span className="flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" /> Sending...
                          </span>
                        ) : (
                          "Send OTP"
                        )}
                      </Button>
                    )}
                  </div>

                  {!isVerified && (
                    <form
                      className="mt-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3"
                      onSubmit={(e: FormEvent) => {
                        e.preventDefault();
                        void confirmOtp(s.channel, code);
                      }}
                    >
                      <div className="space-y-2">
                        <Label htmlFor={`${s.channel}-otp`}>OTP</Label>
                        <Input
                          id={`${s.channel}-otp`}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="6-digit code"
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          className="bg-zinc-950 border-zinc-800"
                          data-testid={`input-otp-${s.channel}`}
                        />
                      </div>
                      <div className="flex items-end">
                        <Button
                          type="submit"
                          className="bg-emerald-600 hover:bg-emerald-700 w-full sm:w-auto"
                          disabled={verifying !== null}
                          data-testid={`button-verify-${s.channel}`}
                        >
                          {verifying === s.channel ? (
                            <span className="flex items-center gap-2">
                              <Loader2 className="w-4 h-4 animate-spin" /> Verifying...
                            </span>
                          ) : (
                            "Verify"
                          )}
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}

            {error && (
              <div className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

