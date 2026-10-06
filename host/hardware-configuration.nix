# Placeholder disk layout so the flake evaluates in CI.
#
# On a real install, run `nixos-generate-config --root /mnt` from the live environment and
# replace this file with the generated one (or use disko). See docs/setup.md.
{ modulesPath, ... }:
{
  imports = [ "${modulesPath}/installer/scan/not-detected.nix" ];

  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };
  fileSystems."/boot" = {
    device = "/dev/disk/by-label/ESP";
    fsType = "vfat";
  };
}
