export interface TuiAnimationPolicyOptions {
  disableAnim?: boolean;
  forceAnim?: boolean;
  env?: Record<string, string | undefined>;
}

const truthyEnv = (value?: string): boolean =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value);

export const shouldEnableTuiAnimations = ({
  disableAnim = false,
  env = process.env,
}: TuiAnimationPolicyOptions = {}): boolean => {
  if (disableAnim || truthyEnv(env.CLOUDEVAL_NO_ANIM)) {
    return false;
  }

  return true;
};
