# Dedicated host for the ephemeral agent fleet.
#
# It does nothing but run disposable systemd-nspawn agent containers and expose the few
# things the (off-box) orchestrator needs to reach them. The control plane — token
# minting, the board, the egress proxy's policy — lives elsewhere; see docs/architecture.md.
#
# `nix build .#fleet-host-vm` runs this host in QEMU for local development.
{ pkgs, fleetContainer, ... }:
{
  system.stateVersion = "25.11";
  networking.hostName = "fleet-host";

  # Machine-specific disk layout. Regenerate on the target with
  # `nixos-generate-config --root /mnt` and replace host/hardware-configuration.nix
  # (or swap this for a disko config). See docs/setup.md.
  imports = [ ./hardware-configuration.nix ];

  # UEFI boot. For a BIOS machine, replace with grub:
  #   boot.loader.grub.enable = true;
  #   boot.loader.grub.devices = [ "/dev/sdX" ];
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  # The agents: each is a systemd-nspawn container, started/stopped by the orchestrator.
  boot.enableContainers = true;

  # Containers attach to a systemd-nspawn network zone (`vz-fleet`). nspawn provides the
  # bridge, a DHCP server, and machine-name DNS for the zone, so a container is reachable
  # from the host at http://<machine-name>:4096 with no per-interface config here.
  networking.useNetworkd = true;
  networking.firewall.enable = true;

  # Keep the agent container system in the host store, so provisioning needs no build on
  # the host at container-start time.
  system.extraDependencies = [ fleetContainer ];

  # The off-box orchestrator drives this host over SSH (its CommandRunner).
  services.openssh.enable = true;
  environment.systemPackages = [ pkgs.git ];
}
