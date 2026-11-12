# The same read-only login as status-board-reader.yaml, for clusters whose
# contents are managed with Terraform's kubernetes provider. Use one or the
# other, not both. Add it next to the existing kubernetes_* resources, once per
# cluster (i.e. per kubernetes provider).

resource "kubernetes_namespace_v1" "status_board" {
  metadata {
    name = "status-board"
  }
}

resource "kubernetes_service_account_v1" "status_board_reader" {
  metadata {
    name      = "status-board-reader"
    namespace = kubernetes_namespace_v1.status_board.metadata[0].name
  }
}

resource "kubernetes_secret_v1" "status_board_reader_token" {
  metadata {
    name      = "status-board-reader-token"
    namespace = kubernetes_namespace_v1.status_board.metadata[0].name
    annotations = {
      "kubernetes.io/service-account.name" = kubernetes_service_account_v1.status_board_reader.metadata[0].name
    }
  }
  type                           = "kubernetes.io/service-account-token"
  wait_for_service_account_token = true
}

resource "kubernetes_cluster_role_v1" "status_board_reader" {
  metadata {
    name = "status-board-reader"
  }

  rule {
    api_groups = ["apps"]
    resources  = ["deployments", "statefulsets"]
    verbs      = ["get", "list"]
  }

  rule {
    api_groups = [""]
    resources  = ["pods"]
    verbs      = ["get", "list"]
  }
}

resource "kubernetes_cluster_role_binding_v1" "status_board_reader" {
  metadata {
    name = "status-board-reader"
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role_v1.status_board_reader.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.status_board_reader.metadata[0].name
    namespace = kubernetes_namespace_v1.status_board.metadata[0].name
  }
}
