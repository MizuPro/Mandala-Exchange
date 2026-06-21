import { Resend } from "resend";
import { env } from "../config/env.js";

// Initialize Resend with the API key from environment variables
// It's possible that the API key is not provided in development mode, so we handle that gracefully.
const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

export async function sendVerificationOTP(toEmail: string, otpCode: string) {
  if (!resend) {
    console.warn(`[EmailService] Resend API key is missing. Skipping email to ${toEmail}. OTP: ${otpCode}`);
    return;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: `Mandala Exchange <${env.emailFrom}>`,
      to: [toEmail],
      subject: "Your Verification Code - Mandala Exchange",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">Welcome to Mandala Exchange!</h2>
          <p>Thank you for registering. Please use the following One-Time Password (OTP) to verify your email address:</p>
          <div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
            <span style="font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #d32f2f;">${otpCode}</span>
          </div>
          <p>This code will expire in 24 hours.</p>
          <p>If you did not request this, please ignore this email.</p>
          <br />
          <p>Best regards,</p>
          <p><strong>The Mandala Exchange Team</strong></p>
        </div>
      `,
    });

    if (error) {
      console.error("[EmailService] Failed to send email:", error);
      throw new Error("Failed to send verification email");
    }

    console.log(`[EmailService] Verification email sent successfully to ${toEmail} (ID: ${data?.id})`);
  } catch (error) {
    console.error("[EmailService] Error sending email:", error);
    throw error;
  }
}
