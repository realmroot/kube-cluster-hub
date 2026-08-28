package inventory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/realmroot/cluster-access-gateway/internal/store"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdv1 "k8s.io/client-go/tools/clientcmd/api/v1"
	apisv1alpha1 "sigs.k8s.io/cluster-inventory-api/apis/v1alpha1"
	ciaclient "sigs.k8s.io/cluster-inventory-api/client/clientset/versioned"
)

const (
	managerName  = "cluster-access-gateway"
	providerName = "oidc-passthrough"
)

type Publisher struct {
	namespace string
	baseURL   string
	client    ciaclient.Interface
	core      kubernetes.Interface
}

func (p *Publisher) Reconcile(ctx context.Context, catalog *store.Store) error {
	after := ""
	for {
		clusters, err := catalog.Clusters(ctx, after, 200)
		if err != nil {
			return err
		}
		for i := range clusters {
			if err := p.Upsert(ctx, &clusters[i]); err != nil {
				_ = catalog.SetInventoryPublication(ctx, clusters[i].ID, "error", err.Error())
				return err
			}
			if err := catalog.SetInventoryPublication(ctx, clusters[i].ID, "ready", ""); err != nil {
				return err
			}
		}
		if len(clusters) < 200 {
			return nil
		}
		after = clusters[len(clusters)-1].ID
	}
}

func New(namespace, baseURL, kubeconfig string) (*Publisher, error) {
	config, err := clientConfig(kubeconfig)
	if err != nil {
		return nil, err
	}
	client, err := ciaclient.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("create Cluster Inventory client: %w", err)
	}
	core, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("create Kubernetes client: %w", err)
	}
	return &Publisher{namespace: namespace, baseURL: strings.TrimRight(baseURL, "/"), client: client, core: core}, nil
}

func (p *Publisher) EnsureNamespace(ctx context.Context) error {
	_, err := p.core.CoreV1().Namespaces().Get(ctx, p.namespace, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	if !apierrors.IsNotFound(err) {
		return err
	}
	_, err = p.core.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: p.namespace}}, metav1.CreateOptions{})
	return err
}

func (p *Publisher) Upsert(ctx context.Context, cluster *store.Cluster) error {
	profiles := p.client.ApisV1alpha1().ClusterProfiles(p.namespace)
	current, err := profiles.Get(ctx, cluster.ID, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		current = &apisv1alpha1.ClusterProfile{ObjectMeta: metav1.ObjectMeta{Name: cluster.ID, Namespace: p.namespace}}
		current.Spec = profileSpec(cluster)
		current.Labels = profileLabels()
		created, createErr := profiles.Create(ctx, current, metav1.CreateOptions{})
		if createErr != nil {
			return fmt.Errorf("create ClusterProfile: %w", createErr)
		}
		current = created
	} else if err != nil {
		return fmt.Errorf("read ClusterProfile: %w", err)
	} else {
		current.Spec = profileSpec(cluster)
		current.Labels = profileLabels()
		current, err = profiles.Update(ctx, current, metav1.UpdateOptions{})
		if err != nil {
			return fmt.Errorf("update ClusterProfile: %w", err)
		}
	}

	current.Status.AccessProviders = []apisv1alpha1.AccessProvider{{
		Name:    providerName,
		Cluster: clientcmdv1.Cluster{Server: p.baseURL + "/clusters/" + cluster.ID + "/kubernetes"},
	}}
	conditionStatus := metav1.ConditionTrue
	reason := "Published"
	message := "Cluster is enabled and published by Cluster Access Gateway"
	if !cluster.Enabled {
		conditionStatus = metav1.ConditionFalse
		reason = "Disabled"
		message = "Cluster is disabled in Cluster Access Gateway"
	}
	current.Status.Conditions = []metav1.Condition{{
		Type: apisv1alpha1.ClusterConditionControlPlaneHealthy, Status: conditionStatus,
		Reason: reason, Message: message, LastTransitionTime: metav1.NewTime(time.Now().UTC()),
	}}
	if _, err := profiles.UpdateStatus(ctx, current, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update ClusterProfile status: %w", err)
	}
	return nil
}

func (p *Publisher) Delete(ctx context.Context, id string) error {
	err := p.client.ApisV1alpha1().ClusterProfiles(p.namespace).Delete(ctx, id, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func profileSpec(cluster *store.Cluster) apisv1alpha1.ClusterProfileSpec {
	return apisv1alpha1.ClusterProfileSpec{
		DisplayName:    cluster.DisplayName,
		ClusterManager: apisv1alpha1.ClusterManager{Name: managerName},
	}
}

func profileLabels() map[string]string {
	return map[string]string{apisv1alpha1.LabelClusterManagerKey: managerName}
}

func clientConfig(path string) (*rest.Config, error) {
	if path != "" {
		config, err := clientcmd.BuildConfigFromFlags("", path)
		if err != nil {
			return nil, fmt.Errorf("load inventory kubeconfig: %w", err)
		}
		return config, nil
	}
	config, err := rest.InClusterConfig()
	if err != nil {
		return nil, errors.New("GATEWAY_INVENTORY_KUBECONFIG is required outside Kubernetes")
	}
	return config, nil
}
